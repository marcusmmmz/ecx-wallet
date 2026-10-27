// The wallet's own Send (#28, docs/adr/0006). Over Esplora the wallet does what a `/v1` server
// would: it gathers the account's spendable coins, the Slot's Chain Module builds the transfer
// (`buildTransfer`), the module's Decoder explains it in the normal approval window, and only then
// is it signed, finalized and broadcast. A Slot whose server speaks the Standard Sidechain API has
// the server build it instead (pull-path.ts).
//
// Coins a broadcast Send spent are held back from later ones until it confirms, or until the server
// has forgotten it for HOLD_BLOCKS blocks: the server may not list the spend in its mempool yet. On
// On Flush any block confirms, a soft one (preconf) included (esplora.ts, `CONFIRMED_AT`).
//
// A Chain Module whose format is `psbt` (Flush) builds from whole transactions, as L1's Deposits do:
// the wallet fetches each coin's, and the module reads its value from it, never from the server.
import { canSend, createKeyRouting, type ChainModules, type KeyedChain, type Keys } from "./accounts";
import { cacheKey, type SessionCache } from "./cache";
import {
  ChainModuleRefusal,
  NATIVE_COIN,
  type AssetAmount,
  type BuiltTrade,
  type BuiltTransfer,
  type ChainEntry,
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
import { checkedOrder, isTransferAskedFor, WATCHED_CHANGE_ADDRESSES, WATCHED_RECEIVE_ADDRESSES, type PullPath, type SendResult } from "./pull-path";
import { rejected, type ApprovalContext, type SignPrompt, type SigningApproval } from "./signing";
import { speaksEsplora } from "./server-api";
import { SidechainServerError, type TransferOrder } from "./sidechain-server";
import { linkDigest, type UsedLinks } from "./flush-links";

/** Blocks past its broadcast after which a Send the server doesn't know releases its coins. */
export const HOLD_BLOCKS = 6;

/** Who the approval window names for a Send over Esplora: the wallet itself built it. */
export const sendRequester = (chainName: string) => `This wallet (Send on ${chainName})`;

/** The coins a broadcast Send spent, held back from later Sends. */
export interface HeldSpend {
  slot: number;
  txid: string;
  spent: { txid: string; vout: number }[];
  /** The server's tip when it was broadcast. */
  tipHeight: number;
}

/** Where held spends are kept (`storage.local`): they must outlive the session. */
export interface HeldStore {
  list(): Promise<HeldSpend[]>;
  put(held: HeldSpend): Promise<void>;
  remove(txid: string): Promise<void>;
}

export interface SendDeps extends Keys, ChainModules {
  /** The Slot's reads and its `/v1` Send. */
  pullPath: PullPath;
  /** A client for `network`'s default server, when it speaks Esplora. */
  esplora(entry: ChainEntry, network: NetworkEntry): EsploraClient;
  openSigningApproval(context: ApprovalContext): SigningApproval;
  isUnlocked(): Promise<boolean>;
  held: HeldStore;
  /** Links whose trade went out this session (docs/adr/0016). */
  usedLinks: UsedLinks;
  /** Where the Slot's last Send refused after approval is kept for the session. */
  cache?: SessionCache;
  /** Milliseconds since the epoch. */
  now(): number;
}

/**
 * A Send that failed after the user approved it: nothing was sent. The page that asked may be gone
 * by then (the toolbar popup closes when the approval window opens), so the Activity feed shows it.
 */
export interface RefusedSend {
  slot: number;
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

  function esplora(target: KeyedChain<Starter>): EsploraClient | undefined {
    const { api } = target.network.sidechainServer;
    if (!speaksEsplora(api)) return undefined;
    if (!canSend(target.module.declare().capabilities, target.network)) {
      throw refusal(`This wallet can't send on ${target.entry.name}: its Chain Module doesn't build transfers.`);
    }
    return deps.esplora(target.entry, target.network);
  }

  /** The Slot's held outpoints, after releasing those whose Send confirmed or was forgotten long enough. */
  async function heldOutpoints(slot: number, server: EsploraClient): Promise<Set<string>> {
    const held = new Set<string>();
    let tip: Promise<number> | undefined;
    for (const spend of (await deps.held.list()).filter((h) => h.slot === slot)) {
      const status = await server.txStatus(spend.txid);
      const forgotten = status === undefined && (await (tip ??= server.tipHeight())) >= spend.tipHeight + HOLD_BLOCKS;
      if (status?.confirmed || forgotten) {
        await deps.held.remove(spend.txid);
        continue;
      }
      for (const { txid, vout } of spend.spent) held.add(`${txid}:${vout}`);
    }
    return held;
  }

  /**
   * The account's spendable coins: explicit and holding something, confirmed or from a trusted
   * transaction (unless the history may have left some out), and not held back. An output with no
   * asset is the chain's own coin. One of value 0 holds no coin: on Flush it's a token's output or
   * an empty fee output. Where the module reads tokens (`tokens`, docs/adr/0013), a confirmed one
   * carrying an asset token is that asset's coin, in its units: the mempool refuses a token spent
   * unconfirmed (`ba-token-unconfirmed`). The module reads the token again when it builds.
   */
  async function spendableCoins(slot: number, target: KeyedChain<Starter>, server: EsploraClient, key: Starter) {
    const account = target.module.deriveAccount(key, { receive: WATCHED_RECEIVE_ADDRESSES, change: WATCHED_CHANGE_ADDRESSES });
    const readsTokens = target.module.declare().capabilities.includes("tokens");
    const addresses = [...account.receive.map((a) => ({ ...a, chain: 0 as const })), ...account.change.map((a) => ({ ...a, chain: 1 as const }))];
    const found = [];
    for (let i = 0; i < addresses.length; i += QUERIES_AT_ONCE) {
      found.push(
        ...(await Promise.all(
          addresses.slice(i, i + QUERIES_AT_ONCE).map(async ({ address, chain, index }) =>
            (await server.addressUtxos(address)).flatMap((u) =>
              u.value === undefined || (u.value === 0 && !(readsTokens && u.confirmed))
                ? []
                : [{ txid: u.txid, vout: u.vout, asset: u.asset ?? NATIVE_COIN, value: String(u.value), chain, index, confirmed: u.confirmed }],
            ),
          ),
        )),
      );
    }
    const utxos = await withTokens(target, server, found.flat());
    const trusted = new Set<string>();
    if (utxos.some((u) => !u.confirmed)) {
      const history = await deps.pullPath.history(slot);
      if (!history.partial) for (const e of history.entries) if (!e.confirmed && e.trusted) trusted.add(e.txid);
    }
    const held = await heldOutpoints(slot, server);
    const coins = utxos
      .filter((u) => (u.confirmed || trusted.has(u.txid)) && !held.has(`${u.txid}:${u.vout}`))
      .map(({ confirmed: _, ...coin }) => coin);
    return { coins, account };
  }

  /**
   * `utxos` with each value-0 one as the asset token its transaction lists on it, by the module;
   * one that carries no asset token (a control coin, a result, nothing) is left out.
   */
  async function withTokens<T extends { txid: string; vout: number; asset: string; value: string }>(
    target: KeyedChain<Starter>,
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

  /** The first change address nothing has paid yet; the last one once all are used. */
  async function changeIndex(server: EsploraClient, change: { address: string; index: number }[]): Promise<number> {
    const counts = await Promise.all(change.map(({ address }) => server.addressTxCount(address)));
    const unused = change.find((_, i) => counts[i] === 0);
    return (unused ?? change[change.length - 1]).index;
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

  /** One Send, once the Slot's previous one is done. */
  async function sendNow(slot: number, order: TransferOrder, from: { origin: string } | undefined, host: string | undefined): Promise<SendResult> {
    const checked = checkedOrder(order);
    const target = await routing.slot(slot);
    const server = esplora(target);
    // An app may ask while the wallet is locked: the window unlocks first, then shows the transfer.
    if (server === undefined) {
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
          spendableCoins(slot, target, server, key),
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
        const prompt: SignPrompt = { origin: requester, chain: target.chain, requestId: `send-${slot}`, decoded };
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
      await deps.held.put({ slot, txid: finalized.txid, spent: built.spent, tipHeight });
      if (txid !== finalized.txid) throw new SidechainServerError(server.url, `${server.url} reported txid ${txid} for transaction ${finalized.txid}.`);
      if (from === undefined) await deps.cache?.set(cacheKey.sendRefused(slot), null);
      return { server: server.url, accepted: true, txid };
    } catch (error) {
      // By now the page that asked may be gone (a popup closes when the approval window opens).
      // Once broadcast it isn't a failed Send: Activity shows the transaction itself. An app's page
      // is still there, and gets the error as its answer.
      if (approved && !broadcast && from === undefined) {
        const reason = error instanceof ProviderRpcError || error instanceof SidechainServerError ? error.message : "Internal wallet error.";
        await deps.cache?.set(cacheKey.sendRefused(slot), { slot, outputs: checked.outputs, reason, at: deps.now() } satisfies RefusedSend);
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
   * What the module needs besides the coins, from the explorer: the pool (`getpool`), the node's
   * quote for it (`getswapquote`), each token's registration, and the least ECX the node pays out.
   * The module checks what it can; the rest can make a trade fail, never pay less than its floor.
   */
  async function tradeFacts(server: EsploraClient, action: FlushAction) {
    const [assetIn, amount, assetOut] =
      action.verb === "swap" ? [action.from, action.amount, action.to] : action.verb === "buy" ? ["ECX", action.ecx, `0x${action.asset}`] : [`0x${action.asset}`, action.tokens, "ECX"];
    const quoted = (await server.flushRpc("getswapquote", [assetIn, amount, assetOut])) as { pools?: { pool?: unknown; curve?: unknown; amount_out?: unknown }[] } | undefined;
    const pools = Array.isArray(quoted?.pools) ? quoted.pools : [];
    // A swap names its pool; a buy or a sale trades on the launch's curve.
    const entry = pools.find((p) => (action.verb === "swap" ? p.pool === action.pool : p.curve === "launch"));
    if (typeof entry?.pool !== "string" || typeof entry.amount_out !== "number") {
      throw refusal("The pool doesn't quote this trade now: ask the site for a fresh link.");
    }
    const pool = (await server.flushRpc("getpool", [entry.pool])) as { asset_a_id?: unknown; asset_b_id?: unknown } | undefined;
    if (typeof pool?.asset_a_id !== "string" || typeof pool.asset_b_id !== "string") throw refusal(`The explorer doesn't describe pool ${entry.pool}.`);
    const tokens = [pool.asset_a_id, pool.asset_b_id].filter((id) => !/^0+$/.test(id));
    const registrations = await Promise.all(
      tokens.map(async (id) => {
        const registration = await server.assetRegistration(id);
        if (registration === undefined) throw refusal(`The explorer doesn't know asset ${id}'s registration.`);
        return server.txHex(registration.txid);
      }),
    );
    const info = (await server.flushRpc("getbitassetsinfo")) as { min_chn_payout?: unknown } | undefined;
    if (typeof info?.min_chn_payout !== "number") throw new SidechainServerError(server.url, `The Sidechain Server at ${server.url} sent a malformed getbitassetsinfo answer.`);
    return { pool, registrations, quote: entry.amount_out, minPayout: info.min_chn_payout };
  }

  /** The built trade's Clear View is exactly the trade checked, every output back to the wallet: else a wallet bug. */
  function isTradeBuilt(view: ClearView, built: BuiltTrade["trade"]): boolean {
    const t = view.trade;
    return (
      t !== undefined &&
      t.pool === built.pool &&
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
      const decoded = await refusing(async () => target.module.decode(built.pset, key, { pool: facts.pool }));
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

  /** Each Slot's last Send or trade, which the next one waits for. */
  const queues = new Map<number, Promise<unknown>>();

  /** Runs `run` once the Slot's previous Send or trade is done. */
  function queued<T>(slot: number, run: () => Promise<T>): Promise<T> {
    const result = (queues.get(slot) ?? Promise.resolve()).then(run, run);
    queues.set(slot, result.catch(() => {}));
    return result;
  }

  return {
    /** Per asset, what a Send on the Slot can spend now: over Esplora confirmed plus trusted, less held; else the reported balance. */
    async spendable(slot: number): Promise<AssetAmount[]> {
      const target = await routing.slot(slot);
      const server = esplora(target);
      if (server === undefined) return (await deps.pullPath.reportedState(slot)).balances;
      await server.checkChain();
      const { coins } = await spendableCoins(slot, target, server, await target.key());
      const totals = new Map<string, bigint>();
      for (const { asset, value } of coins) totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(value));
      return [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() }));
    },

    /**
     * Sends `order` from the Slot. Resolves once broadcast (or accepted by a `/v1` server); throws on
     * refusal or rejection. `from` is the Sidechain App that asked (`sendTransfer`): the approval
     * names it, and a failure after approval goes back to it rather than to the Activity feed.
     * `host` is the wallet page that shows the approval itself (`ApprovalContext`). One Send per
     * Slot at a time, so two never pick the same coins.
     */
    send(slot: number, order: TransferOrder, from?: { origin: string }, host?: string): Promise<SendResult> {
      return queued(slot, () => sendNow(slot, order, from, host));
    },

    /**
     * Trades as `link` (a `flush:` link) asks, for the app `from` (`sendAction`): checked, built from
     * the account's coins, approved Clear, broadcast with its marker's ECX allowed, its coins held and
     * the link kept as run. Throws on refusal or rejection. In the Slot's queue with its Sends.
     */
    trade(slot: number, link: string, from: { origin: string }): Promise<SendResult> {
      return queued(slot, () => tradeNow(slot, link, from));
    },

    /** The Slot's last Send refused after approval this session, if not closed since. */
    refused: async (slot: number): Promise<RefusedSend | undefined> => (await deps.cache?.get<RefusedSend | null>(cacheKey.sendRefused(slot))) ?? undefined,

    /** Forgets the Slot's refused Send. */
    dismissRefused: (slot: number) => deps.cache?.set(cacheKey.sendRefused(slot), null) ?? Promise.resolve(),
  };
}

export type Sends = ReturnType<typeof createSends>;
