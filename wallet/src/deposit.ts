// Deposit (#31): moving eCash into a Slot with an M5, the wallet's own L1 transaction.
//
// The Slot's Chain Module says what the Deposit is credited to (`depositDestination`, from its
// Starter); the wallet finds the Slot's Treasury on its own L1 Esplora (treasury.ts); the L1 module
// builds the M5 from the account's confirmed coins, the L1 Decoder explains it in the normal
// approval window, and only then is it signed, finalized and broadcast. Each module only ever gets
// its own key. No Sidechain Server sees the L1 coins. A Deposit shares the main chain's held coins
// and queue with its Sends (spends.ts, #40): it skips what a Send took, and holds what it takes.
//
// Afterwards the Deposit waits: the Slot's L1 confirmations (6 on betanet), then for someone
// running the Slot's node to import it (crediting isn't automatic on Elements), then it shows on
// the Slot's server. Flush pays it itself: a coinbase output to the address, once a Flush block
// acknowledges the M5's eCash block, matched to the Deposit by address and value (#57).
import { createKeyRouting, type ChainModules, type Keys } from "./accounts";
import { cacheKey, type SessionCache } from "./cache";
import { ChainModuleRefusal, type ChainEntry, type ClearView, type DepositCredit, type L1AccountKey, type L1Module, type NetworkEntry } from "./chain-module";
import { ErrorCode, ProviderRpcError } from "./errors";
import { feeRate, FULL_PAGE_TXS, isCoinbase, QUERIES_AT_ONCE, type EsploraClient, type EsploraTx } from "./esplora";
import { WATCHED_CHANGE_ADDRESSES, WATCHED_RECEIVE_ADDRESSES } from "./pull-path";
import { accountUtxos, changeIndex, createSpendQueue, heldOutpoints, type HeldStore, type SpendQueue } from "./spends";
import { rejected, type ApprovalContext, type SignPrompt, type SigningApproval } from "./signing";
import { speaksEsplora } from "./server-api";
import { SidechainServerError } from "./sidechain-server";
import { findTreasury, TreasuryError } from "./treasury";

/** L1 confirmations before a Slot credits a Deposit, when its Chain Entry doesn't say: BIP300's. */
export const BIP300_DEPOSIT_CONFIRMATIONS = 100;

/** L1 confirmations before the Slot credits a Deposit on this network. */
export const depositConfirmationsOf = (network: NetworkEntry) => network.depositConfirmations ?? BIP300_DEPOSIT_CONFIRMATIONS;

/** One of the account's confirmed coins as the server lists it: its value is the server's word. */
interface ListedCoin {
  txid: string;
  vout: number;
  value: number;
  chain: 0 | 1;
  index: number;
}

/**
 * The most vB an M5 takes besides its coins' inputs: its version, counts and locktime, the
 * Treasury's input and output, a 100-byte destination and change. Overstated, as `enoughCoins` needs.
 */
const M5_VBYTES_BESIDES_COINS = 300;
/** The most vB a coin's input (P2WPKH, signed) adds to an M5. */
const COIN_INPUT_VBYTES = 69;

/**
 * The fewest of `coins`, largest first as `build_deposit` picks them, whose listed values cover
 * `amount` and the most fee they could cost at `feeRate` (sats per 1000 vB); all of them if none
 * do. The module, picking from these, takes as many as it would among all of them (of equal
 * values at the cut, maybe another), so only these coins' transactions need fetching.
 */
export function enoughCoins<C extends { value: number }>(coins: C[], amount: bigint, feeRate: number): C[] {
  const largest = [...coins].sort((a, b) => b.value - a.value);
  let total = 0n;
  for (let count = 1; count <= largest.length; count++) {
    total += BigInt(largest[count - 1].value);
    const fee = BigInt(Math.ceil(((M5_VBYTES_BESIDES_COINS + COIN_INPUT_VBYTES * count) * feeRate) / 1000));
    if (total >= amount + fee) return largest.slice(0, count);
  }
  return largest;
}

/** How far below the Slot's tip when a Deposit was made a reorg may move its credit, in blocks. */
const REORG_SLACK = 10;

/** How long a Deposit waits for the Slot's tip height after its broadcast before it's kept without one. */
const TIP_WAIT_MS = 5_000;

/**
 * Whether the Slot's server lists the Deposit's credit: a transaction to its address with an input
 * claiming its txid. Pages back through the address's confirmed transactions, stopping at one mined
 * below the Slot's tip when the Deposit was made (less `REORG_SLACK`), which its credit can't be.
 * Heights, not times: after a gap in a BMM chain's blocks, a block's time may be hours in the past.
 * Without `slotHeight`, it pages to the end.
 */
export async function isCredited(server: EsploraClient, deposit: Pick<PendingDeposit, "txid" | "address" | "slotHeight">): Promise<boolean> {
  const claims = (tx: EsploraTx) => tx.vin.some((input) => input.claimsDeposit && input.txid === deposit.txid);
  const below = deposit.slotHeight === undefined ? undefined : deposit.slotHeight - REORG_SLACK;
  let page = await server.addressTxs(deposit.address);
  for (;;) {
    if (page.some(claims)) return true;
    const confirmed = page.filter((tx) => tx.status.confirmed);
    const oldest = confirmed.at(-1);
    if (oldest === undefined || confirmed.length < FULL_PAGE_TXS) return false;
    if (below !== undefined && oldest.status.blockHeight! < below) return false;
    page = await server.addressTxsBefore(deposit.address, oldest.txid);
  }
}

/** An output, as `txid:vout`. */
const outpoint = ({ txid, vout }: { txid: string; vout: number }) => `${txid}:${vout}`;

/**
 * Flush's credit for `deposit`: the earliest coinbase output after the first (vout ≥ 1) paying
 * its script exactly its value, in a block above `slotHeight` (a Flush height it can't have been
 * paid at or below), that `claimed` doesn't hold (another Deposit's). Nothing on Flush names the M5, so equal Deposits to the same
 * address are told apart by order: Flush pays them in eCash order, and the wallet matches them
 * oldest first (#57).
 */
export async function flushCredit(
  server: EsploraClient,
  deposit: Pick<PendingDeposit, "address" | "scriptPubkey" | "value"> & { slotHeight: number },
  claimed: Set<string>,
): Promise<{ txid: string; vout: number } | undefined> {
  const { txs } = await server.addressHistory(deposit.address);
  const paid = txs
    .filter((tx) => tx.status.confirmed && isCoinbase(tx) && tx.status.blockHeight! > deposit.slotHeight)
    .sort((a, b) => a.status.blockHeight! - b.status.blockHeight!);
  for (const tx of paid) {
    for (let vout = 1; vout < tx.vout.length; vout++) {
      const { scriptpubkey, value } = tx.vout[vout];
      if (scriptpubkey === deposit.scriptPubkey && String(value) === deposit.value && !claimed.has(outpoint({ txid: tx.txid, vout }))) return { txid: tx.txid, vout };
    }
  }
  return undefined;
}

/** Who the approval window names for a Deposit: the wallet itself asks. */
export const DEPOSIT_REQUESTER = "This wallet (Deposit from the main chain)";

/** A broadcast Deposit the wallet keeps an eye on, until it is credited or the user stops tracking it. */
export interface PendingDeposit {
  slot: number;
  /** The Slot's chain, by name. */
  chainName: string;
  txid: string;
  /** The new Treasury output. */
  vout: number;
  /** Sats, as a decimal string: what the Slot credits. */
  value: string;
  /** Where on the Slot, in its own encoding. */
  address: string;
  /** The asset the credit arrives in. */
  asset: string;
  /** The address's script, hex, where the Slot pays the credit itself (Flush). */
  scriptPubkey?: string;
  /** Flush: the coinbase output matched as its credit, kept so no later Deposit claims it too. */
  credit?: { txid: string; vout: number };
  /** Milliseconds since the epoch. */
  createdAt: number;
  /**
   * The Slot's tip height just after the M5 was broadcast, if its server answered in time: the
   * credit, which waits for the M5's L1 confirmations, is in a later block.
   */
  slotHeight?: number;
}

/** The arguments anyone with the Slot's node can credit the Deposit with (`importdrivechaindeposit`). */
export interface DepositClaim {
  txid: string;
  vout: number;
  blockHash: string;
  address: string;
  value: string;
}

/** Where a pending Deposit stands. Everything but `confirmations` is as the servers report it. */
export type DepositStatus = PendingDeposit &
  (
    | { state: "confirming"; confirmations: number; depositConfirmations: number }
    /**
     * `paidBy: "operator"`: someone running the Slot's node imports it with `claim` (Elements).
     * `"chain"`: the Slot pays it itself in a block of its own (Flush), and there is nothing to claim.
     */
    | {
        state: "awaitingCredit";
        confirmations: number;
        depositConfirmations: number;
        paidBy: "operator" | "chain";
        claim?: DepositClaim;
        creditServer?: string;
      }
    | { state: "credited"; creditServer: string }
    | { state: "notFound"; server: string }
    | { state: "unavailable"; error: string }
  );

/** A Deposit that failed after the user approved it: nothing was sent. */
export interface RefusedDeposit {
  slot: number;
  /** Sats, as a decimal string. */
  value: string;
  /** Why, as the user would have read it on the Deposit screen. */
  reason: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/** Where pending Deposits are kept (`storage.local`). */
export interface DepositStore {
  list(): Promise<PendingDeposit[]>;
  put(deposit: PendingDeposit): Promise<void>;
  remove(txid: string): Promise<void>;
}

export interface DepositDeps extends Keys, ChainModules {
  /** A client for `network`'s default server, which must speak Esplora. */
  esplora(entry: ChainEntry, network: NetworkEntry): EsploraClient;
  /** A window for the approval of one request from `origin` for `chain`, or the page `host`. */
  openSigningApproval(context: ApprovalContext): SigningApproval;
  isUnlocked(): Promise<boolean>;
  store: DepositStore;
  /** The main chain's held coins, shared with its Sends. */
  held: HeldStore;
  /** Runs the main chain's spends one at a time; pass the Sends' one so they share it. Default: its own. */
  queue?: SpendQueue;
  /**
   * Where raw transactions are kept for the session (each checked against its txid first), and
   * the Slot's last Deposit refused after approval.
   */
  cache?: SessionCache;
  /** Milliseconds since the epoch. */
  now(): number;
}

/** A refusal the user reads where they asked for the Deposit. */
const refusal = (message: string) => new ProviderRpcError(ErrorCode.InvalidParams, message);

/**
 * Checks the Clear View is the Deposit that was asked for (one Deposit, to `slot`, of `amount`,
 * credited to `destination`) and adds what the Slot's Chain Module says about its destination.
 * Anything else is a wallet bug: refused, never shown.
 */
function depositView(view: ClearView, slot: number, amount: string, destination: string, credit: DepositCredit): ClearView {
  const deposits = view.outputs.filter((o) => o.destination.kind === "deposit");
  const [only] = deposits;
  if (deposits.length !== 1 || only.destination.kind !== "deposit") throw new Error("The built Deposit doesn't decode as one Deposit.");
  const d = only.destination;
  if (d.slot !== slot || d.deposit !== amount || d.data !== destination) throw new Error("The built Deposit isn't the one asked for.");
  return { ...view, outputs: view.outputs.map((o) => (o === only ? { ...o, destination: { ...d, credit } } : o)) };
}

export function createDeposits(deps: DepositDeps) {
  const routing = createKeyRouting(deps);
  const queue = deps.queue ?? createSpendQueue();

  function esplora(target: { entry: ChainEntry; network: NetworkEntry }): EsploraClient {
    if (target.network.sidechainServer.api !== "esplora") {
      throw refusal(`Deposits need ${target.entry.name}'s server to speak Esplora; its Chain Entry names ${target.network.sidechainServer.api}.`);
    }
    return deps.esplora(target.entry, target.network);
  }

  /** The Slot's server, where its Deposits' credits show, if it speaks Esplora (Flush's explorer included). */
  function creditServer(target: { entry: ChainEntry; network: NetworkEntry }): EsploraClient | undefined {
    const { api } = target.network.sidechainServer;
    return speaksEsplora(api) ? deps.esplora(target.entry, target.network) : undefined;
  }

  /** A raw transaction, from the session's cache or else the server; kept only once it hashes to `txid`. */
  async function txHex(server: EsploraClient, module: L1Module, txid: string): Promise<string> {
    const key = cacheKey.tx(txid);
    const cached = await deps.cache?.get<string>(key);
    if (cached !== undefined) return cached;
    const tx = await server.txHex(txid);
    let actual: string | undefined;
    try {
      actual = module.txid(tx);
    } catch {
      // Not a transaction: refused below.
    }
    if (actual !== txid) throw new SidechainServerError(server.url, `The Sidechain Server at ${server.url} sent another transaction than ${txid}.`);
    await deps.cache?.set(key, tx);
    return tx;
  }

  /**
   * The account's confirmed coins not held by a Send or Deposit, with their values as the server
   * lists them, and the change index: the first unused, else the last.
   */
  async function coins(l1: EsploraClient, module: L1Module, key: L1AccountKey) {
    const account = module.deriveAccount(key, { receive: WATCHED_RECEIVE_ADDRESSES, change: WATCHED_CHANGE_ADDRESSES });
    const [utxos, held, change] = await Promise.all([accountUtxos(l1, account), heldOutpoints(deps.held, "l1", l1), changeIndex(l1, account.change)]);
    const listed: ListedCoin[] = utxos
      .filter((u) => u.confirmed && u.asset === undefined && !held.has(`${u.txid}:${u.vout}`))
      .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value ?? 0, chain: u.chain, index: u.index }));
    return { coins: listed, changeIndex: change };
  }

  /** `coins` as the module takes them: each with its whole transaction, fetched QUERIES_AT_ONCE at a time. */
  async function withTxs(l1: EsploraClient, module: L1Module, coins: ListedCoin[]) {
    const txs = new Map<string, Promise<string>>();
    const tx = (txid: string) => txs.get(txid) ?? txs.set(txid, txHex(l1, module, txid)).get(txid)!;
    const out: { tx: string; vout: number; chain: 0 | 1; index: number }[] = [];
    for (let i = 0; i < coins.length; i += QUERIES_AT_ONCE) {
      out.push(...(await Promise.all(coins.slice(i, i + QUERIES_AT_ONCE).map(async ({ txid, vout, chain, index }) => ({ tx: await tx(txid), vout, chain, index })))));
    }
    return out;
  }

  /** A module refusal or a Treasury it can't determine, as the user reads it. */
  async function refusing<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof ChainModuleRefusal || error instanceof TreasuryError) throw refusal(error.message);
      throw error;
    }
  }

  /**
   * Where each of a Flush Slot's `pending` Deposits (newest first) stands: L1 confirmations, then
   * Flush's payout, matched oldest first so that equal Deposits take their payouts in eCash order.
   * A matched payout is recorded on its Deposit. A credited Deposit is forgotten once no other
   * pending Deposit of the same value to the same script could take its payout instead.
   *
   * A Deposit without `slotHeight` (Flush's server didn't answer at its broadcast) takes Flush's
   * tip while it can't have been paid yet: not on eCash, or short of its confirmations. Until it
   * has one, it isn't matched: any older payout of its value (another Deposit's, one no longer
   * tracked) could pass for its credit.
   */
  async function flushStatuses(
    pending: PendingDeposit[],
    l1: EsploraClient,
    credits: EsploraClient,
    depositConfirmations: number,
    tip: () => Promise<number>,
  ): Promise<DepositStatus[]> {
    const claimed = new Set(pending.flatMap((d) => (d.credit ? [outpoint(d.credit)] : [])));
    const statuses = new Map<string, DepositStatus>();
    for (const deposit of [...pending].reverse()) {
      statuses.set(
        deposit.txid,
        await (async (): Promise<DepositStatus> => {
          try {
            if (deposit.credit) return { ...deposit, state: "credited", creditServer: credits.url };
            const bound = async () => {
              if (deposit.slotHeight !== undefined) return;
              const height = await credits.tipHeight().catch(() => undefined);
              if (height === undefined) return;
              deposit.slotHeight = height;
              await deps.store.put(deposit);
            };
            const status = await l1.txStatus(deposit.txid);
            if (status === undefined) return { ...deposit, state: "notFound", server: l1.url };
            if (!status.confirmed) {
              await bound();
              return { ...deposit, state: "confirming", confirmations: 0, depositConfirmations };
            }
            const confirmations = (await tip()) - status.blockHeight! + 1;
            if (confirmations < depositConfirmations) {
              await bound();
              return { ...deposit, state: "confirming", confirmations, depositConfirmations };
            }
            const { slotHeight } = deposit;
            const credit = deposit.scriptPubkey === undefined || slotHeight === undefined ? undefined : await flushCredit(credits, { ...deposit, slotHeight }, claimed);
            if (credit === undefined) return { ...deposit, state: "awaitingCredit", confirmations, depositConfirmations, paidBy: "chain", creditServer: credits.url };
            claimed.add(outpoint(credit));
            deposit.credit = credit;
            await deps.store.put(deposit);
            return { ...deposit, state: "credited", creditServer: credits.url };
          } catch (error) {
            if (error instanceof SidechainServerError) return { ...deposit, state: "unavailable", error: error.message };
            throw error;
          }
        })(),
      );
    }
    const waiting = (d: PendingDeposit) => statuses.get(d.txid)!.state !== "credited";
    for (const d of pending) {
      const twin = pending.some((o) => o !== d && waiting(o) && o.scriptPubkey === d.scriptPubkey && o.value === d.value);
      if (!waiting(d) && !twin) await deps.store.remove(d.txid);
    }
    return pending.map((d) => statuses.get(d.txid)!);
  }

  /** One Deposit, once the main chain's previous spend is done. */
  async function startNow(slot: number, amount: string, host?: string): Promise<{ txid: string; server: string }> {
    if (!/^[1-9][0-9]*$/.test(amount)) throw refusal("The amount must be a whole number of sats.");
    const l1 = await routing.l1();
    const target = await routing.slot(slot);
    if (!target.module.declare().capabilities.includes("depositDestination")) {
      throw refusal(`${target.entry.name} (Slot ${slot}) can't receive Deposits through this wallet.`);
    }
    const destination = target.module.depositDestination(await target.key());
    if (BigInt(amount) < BigInt(destination.minimum)) throw refusal(`The smallest Deposit to Slot ${slot} is ${destination.minimum} sats.`);

    const server = esplora(l1);
    await server.checkChain();
    const treasury = await refusing(() => findTreasury(server, l1.module.treasuryScript(slot), slot));
    if (treasury === undefined) {
      const { activation } = target.network;
      if (activation === undefined) {
        throw refusal(
          `Slot ${slot} has no Treasury yet, and this wallet has no pinned activation for it, so it can't tell whether the Slot is active.`,
        );
      }
      if ((await server.blockHash(activation.height)) !== activation.hash) {
        throw refusal(`${server.url} doesn't have Slot ${slot}'s activation block ${activation.height} (${activation.hash}).`);
      }
    }
    const rate = feeRate(await server.feeEstimates().catch(() => undefined));
    const key = await l1.key();
    const [{ coins: available, changeIndex }, tipHeight] = await Promise.all([coins(server, l1.module, key), server.tipHeight()]);
    const order = {
      slot,
      amount,
      destination: destination.destination,
      feeRate: rate,
      treasury: treasury === undefined ? null : { tx: await txHex(server, l1.module, treasury.txid), vout: treasury.vout, unconfirmed: treasury.unconfirmed },
      changeIndex,
    };
    // Only the coins it could pick are fetched: a wallet may hold hundreds. If the module, reading
    // their real values, finds them short (the server overstated one), it picks from all of them.
    const build = async (from: ListedCoin[]) => l1.module.buildDeposit({ ...order, coins: await withTxs(server, l1.module, from) }, key);
    const built = await refusing(async () => {
      const enough = enoughCoins(available, BigInt(amount), rate);
      try {
        return await build(enough);
      } catch (error) {
        if (enough.length < available.length && error instanceof ChainModuleRefusal && error.code === "insufficientFunds") return build(available);
        throw error;
      }
    });
    const { psbt } = built;
    await refusing(async () => l1.module.check(psbt));

    const approval = deps.openSigningApproval({ origin: DEPOSIT_REQUESTER, chain: l1.chain, ...(host === undefined ? {} : { host }) });
    let approved = false;
    try {
      const sent = await approveAndSend();
      await deps.cache?.set(cacheKey.depositRefused(slot), null);
      return sent;
    } catch (error) {
      // By now the page that asked may be gone (a popup closes when the approval window opens).
      if (approved) {
        const reason = error instanceof ProviderRpcError || error instanceof SidechainServerError ? error.message : "Internal wallet error.";
        await deps.cache?.set(cacheKey.depositRefused(slot), { slot, value: amount, reason, at: deps.now() } satisfies RefusedDeposit);
      }
      throw error;
    }

    async function approveAndSend(): Promise<{ txid: string; server: string }> {
      let finalized: { tx: string; txid: string };
      let vout: number;
      try {
        if (!(await deps.isUnlocked()) && !(await approval.unlock())) throw rejected();
        const decoded = await refusing(async () => l1.module.decode(psbt, await l1.key()));
        if (decoded.kind !== "clear") throw new Error(`The wallet can't fully explain the Deposit it built: ${decoded.reason}`);
        const credit: DepositCredit = {
          chain: target.chain,
          chainName: target.entry.name,
          address: destination.address,
          yours: true,
          confirmations: depositConfirmationsOf(target.network),
          paidBy: target.network.sidechainServer.api === "flush" ? "chain" : "operator",
        };
        const view = depositView(decoded.view, slot, amount, destination.destination, credit);
        vout = view.outputs.find((o) => o.destination.kind === "deposit")!.index;
        const prompt: SignPrompt = { origin: DEPOSIT_REQUESTER, chain: l1.chain, requestId: `deposit-${slot}`, decoded: { kind: "clear", view } };
        if (!(await approval.confirm(prompt))) throw rejected();
        approved = true;
        const signed = await refusing(async () => l1.module.sign(psbt, await l1.key()));
        finalized = await refusing(async () => l1.module.finalize(signed));
      } finally {
        approval.close();
      }

      let txid: string;
      try {
        txid = await server.broadcast(finalized.tx);
      } catch (error) {
        if (!(error instanceof SidechainServerError)) throw error;
        throw new SidechainServerError(
          error.server,
          `${error.message} Nothing was sent. If another Deposit to Slot ${slot} took its Treasury first, start again to review a new one.`,
        );
      }
      // It went out, whatever the server answers: its coins are held from here on, from Sends too.
      await deps.held.put({ slot: "l1", txid: finalized.txid, spent: built.spent, tipHeight });
      if (txid !== finalized.txid) throw new SidechainServerError(server.url, `${server.url} reported txid ${txid} for transaction ${finalized.txid}.`);
      // Only after the broadcast, and not for long: a Slot server that hangs mustn't hold up the M5.
      const credits = creditServer(target);
      const slotHeight = await Promise.race([
        credits?.tipHeight().catch(() => undefined),
        new Promise<undefined>((resolve) => setTimeout(resolve, TIP_WAIT_MS)),
      ]);
      await deps.store.put({
        slot,
        chainName: target.entry.name,
        txid,
        vout,
        value: amount,
        address: destination.address,
        asset: destination.asset,
        createdAt: deps.now(),
        ...(destination.scriptPubkey === undefined ? {} : { scriptPubkey: destination.scriptPubkey }),
        ...(slotHeight === undefined ? {} : { slotHeight }),
      });
      return { txid, server: server.url };
    }
  }

  return {
    /**
     * Deposits `amount` sats of the wallet's confirmed eCash to `slot`, credited to the Slot's first
     * receive address. Resolves once the M5 is broadcast; throws on refusal or rejection. `host`
     * is the wallet page that shows the approval itself (`ApprovalContext`).
     */
    start(slot: number, amount: string, host?: string): Promise<{ txid: string; server: string }> {
      return queue("l1", () => startNow(slot, amount, host));
    },

    /** The Slot's last Deposit refused after approval this session, if not closed since. */
    refused: async (slot: number): Promise<RefusedDeposit | undefined> => (await deps.cache?.get<RefusedDeposit | null>(cacheKey.depositRefused(slot))) ?? undefined,

    /** Forgets the Slot's refused Deposit. */
    dismissRefused: (slot: number) => deps.cache?.set(cacheKey.depositRefused(slot), null) ?? Promise.resolve(),

    /**
     * The Slot's pending Deposits and where each stands: L1 confirmations (from eCash's server), then
     * the wait for the operator, then credited once the Slot's server lists a transaction to the
     * address with an input claiming the Deposit's txid (`is_pegin`), confirmed or not. A credited
     * Deposit is reported once, then forgotten. On Flush, which pays Deposits itself, the wait is
     * for its coinbase payout (`flushCredit`), matched oldest Deposit first; a credited one is kept
     * while another Deposit of the same value to the same address waits, so that one can't claim it.
     */
    async list(slot: number): Promise<DepositStatus[]> {
      const pending = (await deps.store.list()).filter((d) => d.slot === slot).sort((a, b) => b.createdAt - a.createdAt);
      if (pending.length === 0) return [];
      const l1 = esplora(await routing.l1());
      const target = await routing.slot(slot);
      const credits = creditServer(target);
      const depositConfirmations = depositConfirmationsOf(target.network);
      const paidBy = target.network.sidechainServer.api === "flush" ? ("chain" as const) : ("operator" as const);
      let tip: Promise<number> | undefined;

      if (paidBy === "chain") return flushStatuses(pending, l1, credits!, depositConfirmations, () => (tip ??= l1.tipHeight()));

      return Promise.all(
        pending.map(async (deposit): Promise<DepositStatus> => {
          try {
            const status = await l1.txStatus(deposit.txid);
            if (status === undefined) return { ...deposit, state: "notFound", server: l1.url };
            if (!status.confirmed) return { ...deposit, state: "confirming", confirmations: 0, depositConfirmations };
            const confirmations = (await (tip ??= l1.tipHeight())) - status.blockHeight! + 1;
            if (confirmations < depositConfirmations) return { ...deposit, state: "confirming", confirmations, depositConfirmations };
            const claim = { txid: deposit.txid, vout: deposit.vout, blockHash: status.blockHash!, address: deposit.address, value: deposit.value };
            if (credits === undefined) return { ...deposit, state: "awaitingCredit", confirmations, depositConfirmations, paidBy, claim };
            if (!(await isCredited(credits, deposit))) return { ...deposit, state: "awaitingCredit", confirmations, depositConfirmations, paidBy, claim, creditServer: credits.url };
            await deps.store.remove(deposit.txid);
            return { ...deposit, state: "credited", creditServer: credits.url };
          } catch (error) {
            if (error instanceof SidechainServerError) return { ...deposit, state: "unavailable", error: error.message };
            throw error;
          }
        }),
      );
    },

    /** Stops watching a Deposit (the funds aren't affected). */
    dismiss: (txid: string) => deps.store.remove(txid),
  };
}

export type Deposits = ReturnType<typeof createDeposits>;
