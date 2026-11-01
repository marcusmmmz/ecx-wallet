// The wallet's own Send (#28, docs/adr/0006). Over Esplora the wallet does what a `/v1` server
// would: it gathers the account's spendable coins, the Slot's Chain Module builds the transfer
// (`buildTransfer`), the module's Decoder explains it in the normal approval window, and only then
// is it signed, finalized and broadcast. A Slot whose server speaks the Standard Sidechain API has
// the server build it instead (pull-path.ts).
//
// The main chain sends the same way (#40): its module builds, decodes and signs as a Slot's does,
// with the L1 Account Key, and the approval names "This wallet (Send on Main chain)".
//
// Coins a broadcast Send spent are held back from later ones (spends.ts); on the main chain from
// later Deposits too. On Flush a block confirms once a block of stake is on top of it (esplora.ts,
// `FLUSH_CONFIRMATIONS`).
//
// A Chain Module whose format is `psbt` (Flush, eCash) builds from whole transactions, as L1's
// Deposits do: the wallet fetches each coin's, and the module reads its value from it, never from
// the server.
import { canSend, createKeyRouting, type ChainModules, type KeyedChain, type Keys } from "./accounts";
import { cacheKey, type SessionCache } from "./cache";
import {
  ChainModuleRefusal,
  NATIVE_COIN,
  type AssetAmount,
  type BuiltTrade,
  type BuiltTransfer,
  type ChainEntry,
  type ChainKey,
  type ClearView,
  type FlushAction,
  type ModuleTransferOrder,
  type NetworkEntry,
  type OutputTokens,
  type ReportedCoin,
  type Starter,
  type TransferOutput,
  type WholeTxCoin,
} from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import { feeRate, QUERIES_AT_ONCE, type EsploraClient } from "./esplora";
import { accountUtxos, changeIndex, createSpendQueue, heldOutpoints, type ChainId, type HeldStore, type SpendQueue } from "./spends";
import { checkedOrder, isTransferAskedFor, WATCHED_CHANGE_ADDRESSES, WATCHED_RECEIVE_ADDRESSES, type PullPath, type SendResult } from "./pull-path";
import { rejected, type ApprovalContext, type SignPrompt, type SigningApproval } from "./signing";
import { speaksEsplora } from "./server-api";
import { SidechainServerError, type TransferOrder } from "./sidechain-server";
import { linkDigest, type UsedLinks } from "./flush-links";

/** Who the approval window names for a Send over Esplora: the wallet itself built it. */
export const sendRequester = (chainName: string) => `This wallet (Send on ${chainName})`;

export interface SendDeps extends Keys, ChainModules {
  /** The Slot's reads and its `/v1` Send. */
  pullPath: PullPath;
  /** A client for `network`'s default server, when it speaks Esplora. */
  esplora(entry: ChainEntry, network: NetworkEntry): EsploraClient;
  openSigningApproval(context: ApprovalContext): SigningApproval;
  isUnlocked(): Promise<boolean>;
  held: HeldStore;
  /** Runs each chain's spends one at a time; pass the Deposits' one so the main chain's share it. Default: its own. */
  queue?: SpendQueue;
  /** Links whose trade went out this session (docs/adr/0016). */
  usedLinks: UsedLinks;
  /** Where each chain's last Send refused after approval is kept for the session. */
  cache?: SessionCache;
  /** Milliseconds since the epoch. */
  now(): number;
}

/**
 * A Send that failed after the user approved it: nothing was sent. The page that asked may be gone
 * by then (the toolbar popup closes when the approval window opens), so the Activity feed shows it.
 */
export interface RefusedSend {
  slot: ChainId;
  outputs: TransferOutput[];
  /** Why, as the user would have read it on the Send screen. */
  reason: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/** A refusal the user reads where they asked for the Send. */
const refusal = (message: string) => new ProviderRpcError(ErrorCode.InvalidParams, message);

export function createSends(deps: SendDeps) {
  const routing = createKeyRouting(deps);
  const queue = deps.queue ?? createSpendQueue();

  function esplora<K extends ChainKey>(target: KeyedChain<K>): EsploraClient | undefined {
    const { api } = target.network.sidechainServer;
    if (!speaksEsplora(api)) return undefined;
    if (!canSend(target.module.declare().capabilities, target.network)) {
      throw refusal(`This wallet can't send on ${target.entry.name}: its Chain Module doesn't build transfers.`);
    }
    return deps.esplora(target.entry, target.network);
  }

  /**
   * The account's spendable coins: explicit and holding something, confirmed or from a trusted
   * transaction (unless the history may have left some out), and not held back. An output with no
   * asset is the chain's own coin. One of value 0 holds no coin: on Flush it's a token's output or
   * an empty fee output. Where the module reads tokens (`tokens`, docs/adr/0013), a confirmed one
   * carrying an asset token is that asset's coin, in its units: the mempool refuses a token spent
   * unconfirmed (`ba-token-unconfirmed`). The module reads the token again when it builds.
   */
  async function spendableCoins<K extends ChainKey>(chain: ChainId, target: KeyedChain<K>, server: EsploraClient, key: K) {
    const account = target.module.deriveAccount(key, { receive: WATCHED_RECEIVE_ADDRESSES, change: WATCHED_CHANGE_ADDRESSES });
    const readsTokens = target.module.declare().capabilities.includes("tokens");
    const found = (await accountUtxos(server, account)).flatMap((u) =>
      u.value === undefined || (u.value === 0 && !(readsTokens && u.confirmed))
        ? []
        : [{ txid: u.txid, vout: u.vout, asset: u.asset ?? NATIVE_COIN, value: String(u.value), chain: u.chain, index: u.index, confirmed: u.confirmed }],
    );
    const utxos = await withTokens(target, server, found);
    const trusted = new Set<string>();
    if (utxos.some((u) => !u.confirmed)) {
      const history = await (chain === "l1" ? deps.pullPath.l1History() : deps.pullPath.history(chain));
      if (!history.partial) for (const e of history.entries) if (!e.confirmed && e.trusted) trusted.add(e.txid);
    }
    const held = await heldOutpoints(deps.held, chain, server);
    const coins = utxos
      .filter((u) => (u.confirmed || trusted.has(u.txid)) && !held.has(`${u.txid}:${u.vout}`))
      .map(({ confirmed: _, ...coin }) => coin);
    return { coins, account };
  }

  /**
   * `utxos` with each value-0 one as the asset token its transaction lists on it, by the module;
   * one that carries no asset token (a control coin, a result, nothing) is left out.
   */
  async function withTokens<K extends ChainKey, T extends { txid: string; vout: number; asset: string; value: string }>(
    target: KeyedChain<K>,
    server: EsploraClient,
    utxos: T[],
  ): Promise<T[]> {
    const txids = [...new Set(utxos.filter((u) => u.value === "0").map((u) => u.txid))];
    if (txids.length === 0) return utxos;
    const listed = new Map<string, OutputTokens>();
    for (let i = 0; i < txids.length; i += QUERIES_AT_ONCE) {
      const batch = txids.slice(i, i + QUERIES_AT_ONCE);
      const hex = await Promise.all(batch.map((txid) => server.txHex(txid)));
      hex.forEach((tx, j) => {
        const tokens = target.module.outputTokens(tx);
        if (tokens.txid !== batch[j]) throw refusal(`The Sidechain Server at ${server.url} sent another transaction for ${batch[j]}.`);
        listed.set(batch[j], tokens);
      });
    }
    return utxos.flatMap((u) => {
      if (u.value !== "0") return [u];
      const token = listed.get(u.txid)!.outputs.find((o) => o.vout === u.vout)?.token;
      return token?.kind === "asset" ? [{ ...u, asset: token.id, value: token.amount }] : [];
    });
  }

  /** `coins` as whole transactions, for a `psbt` module. Each is fetched once; the module checks what it holds. */
  async function wholeTxCoins(server: EsploraClient, coins: ReportedCoin[]): Promise<WholeTxCoin[]> {
    const txids = [...new Set(coins.map((c) => c.txid))];
    const hex = new Map<string, string>();
    for (let i = 0; i < txids.length; i += QUERIES_AT_ONCE) {
      const batch = txids.slice(i, i + QUERIES_AT_ONCE);
      (await Promise.all(batch.map((txid) => server.txHex(txid)))).forEach((tx, j) => hex.set(batch[j], tx));
    }
    return coins.map(({ txid, vout, chain, index }) => ({ tx: hex.get(txid)!, vout, chain, index }));
  }

  /** A module refusal, as the user reads it. */
  async function refusing<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ChainModuleRefusal) throw refusal(error.message);
      throw error;
    }
  }

  /** One Send on `chain`, once its previous spend is done. */
  async function sendNow(chain: ChainId, order: TransferOrder, from: { origin: string } | undefined, host: string | undefined): Promise<SendResult> {
    const checked = checkedOrder(order);
    return chain === "l1" ? sendWith(chain, await routing.l1(), checked, undefined, host) : sendWith(chain, await routing.slot(chain), checked, from, host);
  }

  async function sendWith<K extends ChainKey>(
    chain: ChainId,
    target: KeyedChain<K>,
    checked: TransferOrder,
    from: { origin: string } | undefined,
    host: string | undefined,
  ): Promise<SendResult> {
    const server = esplora(target);
    // An app may ask while the wallet is locked: the window unlocks first, then shows the transfer.
    if (server === undefined) {
      if (chain === "l1") throw new Error("The main chain's server always speaks Esplora.");
      const slot = chain;
      if (from === undefined) return deps.pullPath.send(slot, checked);
      const approval = deps.openSigningApproval({ origin: from.origin, chain: target.chain });
      try {
        if (!(await deps.isUnlocked()) && !(await approval.unlock())) throw rejected();
        return await deps.pullPath.send(slot, checked, { requester: from.origin, approval });
      } finally {
        approval.close();
      }
    }

    const requester = from?.origin ?? sendRequester(target.entry.name);
    const approval = deps.openSigningApproval({ origin: requester, chain: target.chain, ...(host === undefined ? {} : { host }) });
    let approved = false;
    let broadcast = false;
    try {
      let built: BuiltTransfer;
      let tipHeight: number;
      let finalized: { tx: string; txid: string };
      try {
        if (!(await deps.isUnlocked()) && !(await approval.unlock())) throw rejected();
        await server.checkChain();
        const key = await target.key();
        const [{ coins, account }, estimates, tip] = await Promise.all([
          spendableCoins(chain, target, server, key),
          server.feeEstimates().catch(() => undefined),
          server.tipHeight(),
        ]);
        tipHeight = tip;
        const wholeTxs = target.module.declare().binding.format === "psbt";
        const moduleOrder: ModuleTransferOrder = {
          coins: wholeTxs ? await wholeTxCoins(server, coins) : coins,
          outputs: checked.outputs,
          feeRate: feeRate(estimates),
          changeIndex: await changeIndex(server, account.change),
        };
        built = await refusing(async () => target.module.buildTransfer(moduleOrder, key));
        // The module names what it spends by the transactions it was given: a server that sent another
        // transaction than the one it listed would have the wrong coins held back.
        const offered = new Set(coins.map((c) => `${c.txid}:${c.vout}`));
        if (!built.spent.every((s) => offered.has(`${s.txid}:${s.vout}`))) {
          throw new SidechainServerError(server.url, `The Sidechain Server at ${server.url} sent a transaction that isn't one it listed. Nothing was sent.`);
        }
        await refusing(async () => target.module.check(built.pset));

        const decoded = await refusing(async () => target.module.decode(built.pset, await target.key()));
        if (decoded.kind !== "clear") throw new Error(`The wallet can't fully explain the transfer it built: ${decoded.reason}`);
        // Anything else is a wallet bug: refused, never shown.
        if (!isTransferAskedFor(decoded.view, checked)) throw new Error("The built transfer isn't the one asked for.");
        const prompt: SignPrompt = { origin: requester, chain: target.chain, requestId: `send-${chain}`, decoded };
        if (!(await approval.confirm(prompt))) throw rejected();
        approved = true;
        const signed = await refusing(async () => target.module.sign(built.pset, await target.key()));
        finalized = await refusing(async () => target.module.finalize(signed));
      } finally {
        approval.close();
      }

      let txid: string;
      try {
        txid = await server.broadcast(finalized.tx);
        broadcast = true;
      } catch (error) {
        if (!(error instanceof SidechainServerError)) throw error;
        throw new SidechainServerError(error.server, `${error.message} Nothing was sent.`);
      }
      // It went out, whatever the server answers: its coins are held from here on.
      await deps.held.put({ slot: chain, txid: finalized.txid, spent: built.spent, tipHeight });
      if (txid !== finalized.txid) throw new SidechainServerError(server.url, `${server.url} reported txid ${txid} for transaction ${finalized.txid}.`);
      if (from === undefined) await deps.cache?.set(cacheKey.sendRefused(chain), null);
      return { server: server.url, accepted: true, txid };
    } catch (error) {
      // By now the page that asked may be gone (a popup closes when the approval window opens).
      // Once broadcast it isn't a failed Send: Activity shows the transaction itself. An app's page
      // is still there, and gets the error as its answer.
      if (approved && !broadcast && from === undefined) {
        const reason = error instanceof ProviderRpcError || error instanceof SidechainServerError ? error.message : "Internal wallet error.";
        await deps.cache?.set(cacheKey.sendRefused(chain), { slot: chain, outputs: checked.outputs, reason, at: deps.now() } satisfies RefusedSend);
      }
      throw error;
    }
  }

  /** The link's trade, as the module reads it: a link it doesn't build is unsupported (4200), a bad one invalid. */
  function parsedAction(target: KeyedChain<Starter>, link: string): FlushAction {
    try {
      return target.module.parseAction(link, Math.floor(deps.now() / 1000));
    } catch (error) {
      if (error instanceof ChainModuleRefusal && error.code === "unsupportedAction") throw new ProviderRpcError(ErrorCode.UnsupportedMethod, error.message);
      if (error instanceof ChainModuleRefusal) throw refusal(error.message);
      throw error;
    }
  }

  /**
   * What the module needs besides the coins, from the explorer: the pools (`getpool`), the node's
   * quote for them (`getswapquote`; a route's hop by hop, each pool alone, as Flush's app quotes it),
   * each token's registration, and the least ECX the node pays out. The module checks what it can
   * (a route's path is its own walk); the rest can make a trade fail, never pay less than its floor.
   */
  async function tradeFacts(server: EsploraClient, action: FlushAction) {
    const ECX = "0".repeat(64);
    const label = (id: string) => (id === ECX ? "ECX" : `0x${id}`);
    const described = async (id: string) => {
      const pool = (await server.flushRpc("getpool", [id])) as { asset_a_id?: unknown; asset_b_id?: unknown } | undefined;
      if (typeof pool?.asset_a_id !== "string" || typeof pool.asset_b_id !== "string") throw refusal(`The explorer doesn't describe pool ${id}.`);
      return pool as { asset_a_id: string; asset_b_id: string };
    };
    /** What `pool` (or, unnamed, the launch's curve) gives now for `amount` of `assetIn`, in whole units of `assetOut`. */
    const quoteOf = async (assetIn: string, amount: string | number, assetOut: string, pool?: string) => {
      const quoted = (await server.flushRpc("getswapquote", [assetIn, amount, assetOut])) as { pools?: { pool?: unknown; curve?: unknown; amount_out?: unknown }[] } | undefined;
      const pools = Array.isArray(quoted?.pools) ? quoted.pools : [];
      const entry = pools.find((p) => (pool !== undefined ? p.pool === pool : p.curve === "launch"));
      if (typeof entry?.pool !== "string" || typeof entry.amount_out !== "number") {
        throw refusal("The pool doesn't quote this trade now: ask the site for a fresh link.");
      }
      return { pool: entry.pool, amountOut: entry.amount_out };
    };

    let pools: { asset_a_id: string; asset_b_id: string }[];
    let quote: number;
    if (action.verb === "route") {
      // Each hop's assets, by the pools' own: the module walks it again, and refuses what doesn't follow.
      pools = await Promise.all(action.pools.map(described));
      const ids = (pool: { asset_a_id: string; asset_b_id: string }) => [pool.asset_a_id.toLowerCase(), pool.asset_b_id.toLowerCase()];
      // It starts at the first pool's side the second doesn't hold. The link names `from` by ticker,
      // whose id only the module derives: it checks this start is the link's from.
      const first = ids(pools[0]);
      let at = first.find((id) => !ids(pools[1]).includes(id)) ?? first[0];
      let amount: string | number = action.amount;
      for (const [i, pool] of pools.entries()) {
        const [a, b] = ids(pool);
        if (at !== a && at !== b) throw refusal(`Pool ${action.pools[i]} doesn't take what comes to it: the route's pools don't follow one another.`);
        const next = at === a ? b : a;
        amount = (await quoteOf(label(at), amount, label(next), action.pools[i])).amountOut;
        at = next;
      }
      quote = amount as number;
    } else {
      const [assetIn, amount, assetOut] =
        action.verb === "swap" ? [action.from, action.amount, action.to] : action.verb === "buy" ? ["ECX", action.ecx, `0x${action.asset}`] : [`0x${action.asset}`, action.tokens, "ECX"];
      // A swap names its pool; a buy or a sale trades on the launch's curve.
      const quoted = await quoteOf(assetIn, amount, assetOut, action.verb === "swap" ? action.pool : undefined);
      pools = [await described(quoted.pool)];
      quote = quoted.amountOut;
    }
    const tokens = [...new Set(pools.flatMap((pool) => [pool.asset_a_id.toLowerCase(), pool.asset_b_id.toLowerCase()]))].filter((id) => id !== ECX);
    const registrations = await Promise.all(
      tokens.map(async (id) => {
        const registration = await server.assetRegistration(id);
        if (registration === undefined) throw refusal(`The explorer doesn't know asset ${id}'s registration.`);
        return server.txHex(registration.txid);
      }),
    );
    const info = (await server.flushRpc("getbitassetsinfo")) as { min_chn_payout?: unknown } | undefined;
    if (typeof info?.min_chn_payout !== "number") throw new SidechainServerError(server.url, `The Sidechain Server at ${server.url} sent a malformed getbitassetsinfo answer.`);
    return { pools, registrations, quote, minPayout: info.min_chn_payout };
  }

  /** The built trade's Clear View is exactly the trade checked, every output back to the wallet: else a wallet bug. */
  function isTradeBuilt(view: ClearView, built: BuiltTrade["trade"]): boolean {
    const t = view.trade;
    return (
      t !== undefined &&
      t.pools.length === built.pools.length &&
      t.pools.every((pool, i) => pool === built.pools[i]) &&
      t.via.length === built.via.length &&
      t.via.every((asset, i) => asset === built.via[i].id) &&
      t.assetIn === built.assetIn.id &&
      t.amountIn === built.amountIn &&
      t.assetOut === built.assetOut.id &&
      t.minOut === built.minOut &&
      t.warnings.length === 0 &&
      (t.payout === null || (t.payout.kind === "address" && t.payout.yours)) &&
      view.outputs.every((o) => o.destination.kind === "address" && o.destination.yours)
    );
  }

  /** One trade an app's link asks for (`sendAction`, docs/adr/0016), once the Slot's previous Send is done. */
  async function tradeNow(slot: number, link: string, from: { origin: string }): Promise<SendResult> {
    const target = await routing.slot(slot);
    const server = esplora(target);
    if (server === undefined || !target.module.declare().capabilities.includes("trades")) {
      throw new ProviderRpcError(ErrorCode.UnsupportedMethod, `This wallet can't trade on ${target.entry.name}.`);
    }
    const action = parsedAction(target, link);
    const digest = await linkDigest(link);
    if (await deps.usedLinks.has(digest)) throw refusal("This link has already run: ask the site for a fresh one.");
    await server.checkChain();
    const facts = await tradeFacts(server, action);

    const approval = deps.openSigningApproval({ origin: from.origin, chain: target.chain });
    let built: BuiltTrade;
    let tipHeight: number;
    let finalized: { tx: string; txid: string };
    try {
      if (!(await deps.isUnlocked()) && !(await approval.unlock())) throw rejected();
      const key = await target.key();
      const [{ coins, account }, estimates, tip] = await Promise.all([
        spendableCoins(slot, target, server, key),
        server.feeEstimates().catch(() => undefined),
        server.tipHeight(),
      ]);
      tipHeight = tip;
      const order = {
        link,
        now: Math.floor(deps.now() / 1000),
        ...facts,
        coins: await wholeTxCoins(server, coins),
        feeRate: feeRate(estimates),
        changeIndex: await changeIndex(server, account.change),
      };
      built = await refusing(async () => target.module.buildTrade(order, key));
      const offered = new Set(coins.map((c) => `${c.txid}:${c.vout}`));
      if (!built.spent.every((s) => offered.has(`${s.txid}:${s.vout}`))) {
        throw new SidechainServerError(server.url, `The Sidechain Server at ${server.url} sent a transaction that isn't one it listed. Nothing was sent.`);
      }
      await refusing(async () => target.module.check(built.pset));
      const decoded = await refusing(async () => target.module.decode(built.pset, key, { pools: facts.pools }));
      if (decoded.kind !== "clear") throw new Error(`The wallet can't fully explain the trade it built: ${decoded.reason}`);
      if (!isTradeBuilt(decoded.view, built.trade)) throw new Error("The built trade isn't the one asked for.");
      const prompt: SignPrompt = { origin: from.origin, chain: target.chain, requestId: `trade-${slot}`, decoded, trade: built.trade };
      if (!(await approval.confirm(prompt))) throw rejected();
      const signed = await refusing(async () => target.module.sign(built.pset, key));
      finalized = await refusing(async () => target.module.finalize(signed));
    } finally {
      approval.close();
    }

    let txid: string;
    try {
      txid = await server.broadcast(finalized.tx, built.burn);
    } catch (error) {
      if (!(error instanceof SidechainServerError)) throw error;
      throw new SidechainServerError(error.server, `${error.message} Nothing was sent.`);
    }
    await deps.held.put({ slot, txid: finalized.txid, spent: built.spent, tipHeight });
    await deps.usedLinks.add(digest);
    if (txid !== finalized.txid) throw new SidechainServerError(server.url, `${server.url} reported txid ${txid} for transaction ${finalized.txid}.`);
    return { server: server.url, accepted: true, txid };
  }

  /** Per asset, what a Send on the chain can spend now: over Esplora confirmed plus trusted, less held; else the reported balance. */
  async function spendableWith<K extends ChainKey>(chain: ChainId, target: KeyedChain<K>): Promise<AssetAmount[]> {
    const server = esplora(target);
    if (server === undefined) {
      if (chain === "l1") throw new Error("The main chain's server always speaks Esplora.");
      return (await deps.pullPath.reportedState(chain)).balances;
    }
    await server.checkChain();
    const { coins } = await spendableCoins(chain, target, server, await target.key());
    const totals = new Map<string, bigint>();
    for (const { asset, value } of coins) totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(value));
    return [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() }));
  }

  return {
    /** Per asset, what a Send on the chain (a Slot, or "l1") can spend now. */
    spendable: async (chain: ChainId): Promise<AssetAmount[]> => (chain === "l1" ? spendableWith(chain, await routing.l1()) : spendableWith(chain, await routing.slot(chain))),

    /**
     * Sends `order` from the chain (a Slot, or "l1" for the main chain). Resolves once broadcast (or
     * accepted by a `/v1` server); throws on refusal or rejection. `from` is the Sidechain App that
     * asked (`sendTransfer`, a Slot only): the approval names it, and a failure after approval goes
     * back to it rather than to the Activity feed. `host` is the wallet page that shows the approval
     * itself (`ApprovalContext`). One spend per chain at a time, so two never pick the same coins.
     */
    send(chain: ChainId, order: TransferOrder, from?: { origin: string }, host?: string): Promise<SendResult> {
      return queue(chain, () => sendNow(chain, order, from, host));
    },

    /**
     * Trades as `link` (a `flush:` link) asks, for the app `from` (`sendAction`): checked, built from
     * the account's coins, approved Clear, broadcast with its marker's ECX allowed, its coins held and
     * the link kept as run. Throws on refusal or rejection. In the Slot's queue with its Sends.
     */
    trade(slot: number, link: string, from: { origin: string }): Promise<SendResult> {
      return queue(slot, () => tradeNow(slot, link, from));
    },

    /** The chain's last Send refused after approval this session, if not closed since. */
    refused: async (chain: ChainId): Promise<RefusedSend | undefined> => (await deps.cache?.get<RefusedSend | null>(cacheKey.sendRefused(chain))) ?? undefined,

    /** Forgets the chain's refused Send. */
    dismissRefused: (chain: ChainId) => deps.cache?.set(cacheKey.sendRefused(chain), null) ?? Promise.resolve(),
  };
}

export type Sends = ReturnType<typeof createSends>;
