// Flush trades in history (docs/adr/0017, 0018). A trade (kind 21) says what it pays in; what comes
// out is only in the node's state. The node's DEX API reports each order's outcome by its txid
// (`trades/{txid}`): filled or missed, and what it paid out. ECX is paid by a coinbase output to the
// order's `chn_to` of exactly that amount, which names no trade: from `v7_height`, the coinbase of
// the trade's own block. So the wallet pairs each ECX payout with the earliest unclaimed coinbase
// output to its `chn_to` of the amount reported, in that block (before `v7_height`, at or after it),
// and folds it into the trade's entry.
import { cacheKey, type SessionCache } from "./cache";
import { NATIVE_COIN, type AssetAmount, type OutputTokens } from "./chain-module";
import { isCoinbase, QUERIES_AT_ONCE, type EsploraClient, type EsploraTx, type MarketPayout, type MarketStatus, type MarketTrade } from "./esplora";
import type { HistoryEntry, PayoutState, TradeOutcome } from "./sidechain-server";

/** What the market index said of a transaction: its outcome, or that it knows no order by it. */
type Answer = MarketTrade | { none: true };

/** Where answers are kept for good: only for trades in a final block, which no reorg can undo. */
export type TradeStore = Pick<SessionCache, "get" | "set">;

/** Flush writes ECX as the null hash, or as `""`, which is already NATIVE_COIN. */
const assetOf = (id: string) => (/^0{64}$/.test(id) ? NATIVE_COIN : id);

/**
 * Each of `entries` with its trade, if it is one: a kind-21 order funded by the wallet alone (so its
 * fee is known), paying ECX to one of `ours`, that the market index knows. Its payouts are folded in.
 */
export async function withTrades(
  entries: HistoryEntry[],
  txs: Map<string, EsploraTx>,
  markers: Map<string, OutputTokens | undefined>,
  ours: Set<string>,
  client: Pick<EsploraClient, "marketStatus" | "marketTrade" | "url">,
  caches: { session?: SessionCache; store?: TradeStore },
): Promise<HistoryEntry[]> {
  const trades = entries.flatMap((entry) => {
    const tx = txs.get(entry.txid)!;
    const order = markers.get(entry.txid)?.swap;
    if (order === undefined || order.pools.length === 0 || !ours.has(order.chnTo)) return [];
    if (!tx.vin.every(({ prevout }) => prevout !== null && ours.has(prevout.scriptpubkey) && prevout.value !== undefined)) return [];
    const fee = tx.vin.reduce((sum, { prevout }) => sum + BigInt(prevout!.value!), 0n) - tx.vout.reduce((sum, o) => sum + BigInt(o.value ?? 0), 0n);
    return [{ entry, tx, order, fee }];
  });
  if (trades.length === 0) return entries;

  let status: Promise<MarketStatus> | undefined;
  const market = () => (status ??= client.marketStatus());
  // For good: under its own prefix, so locking (which forgets the session's cache) keeps it.
  const key = (txid: string) => `trade:${client.url}:${txid}`;
  const statusKey = `trade-status:${client.url}`;

  /** The index's answer: kept for good, else for the session (by block: a soft one can be replaced), else asked. */
  async function answer(tx: EsploraTx): Promise<Answer | "settling"> {
    const stored = await caches.store?.get<unknown>(key(tx.txid));
    if (isAnswer(stored)) return stored;
    const sessionKey = cacheKey.trade(client.url, tx.txid, tx.status.blockHash!);
    const kept = await caches.session?.get<unknown>(sessionKey);
    if (isAnswer(kept)) return kept;
    // Until the index reaches the trade's block, it has no outcome: only past it does a 404 mean no order.
    if ((await market()).height < tx.status.blockHeight!) return "settling";
    const found: Answer = (await client.marketTrade(tx.txid)) ?? { none: true };
    await caches.session?.set(sessionKey, found);
    // A 404 only for the session: an index being rebuilt may answer one for a real trade.
    if (tx.status.final && !("none" in found)) await caches.store?.set(key(tx.txid), found);
    return found;
  }

  /** A trade's outcome, and the ECX payouts a coinbase pays it; undefined if the index knows no order by it. */
  type Read = { outcome: TradeOutcome; ecxPayouts: MarketPayout[] } | undefined;
  async function outcomeOf(tx: EsploraTx): Promise<Read> {
    if (!tx.status.confirmed) return { outcome: { state: "settling" }, ecxPayouts: [] };
    try {
      const said = await answer(tx);
      if (said === "settling") return { outcome: { state: "settling" }, ecxPayouts: [] };
      if ("none" in said) return undefined;
      const main = said.payouts.find((p) => p.what === (said.status === "filled" ? "out" : "refund"));
      if (main === undefined) throw new Error(`The market index reports no ${said.status === "filled" ? "payout" : "refund"} for it.`);
      const ecxPayouts = said.payouts.filter((p) => p.via === "coinbase" && assetOf(p.asset) === NATIVE_COIN && (p === main || p.what === "back"));
      return { outcome: { state: said.status, back: { asset: assetOf(main.asset), amount: main.amount } }, ecxPayouts };
    } catch (error) {
      return { outcome: unknown(error), ecxPayouts: [] };
    }
  }
  // At most QUERIES_AT_ONCE at a time: each answer not kept is a request to the server.
  const read: Read[] = [];
  for (let i = 0; i < trades.length; i += QUERIES_AT_ONCE) read.push(...(await Promise.all(trades.slice(i, i + QUERIES_AT_ONCE).map(({ tx }) => outcomeOf(tx)))));
  // Pairing needs the height payouts are instant from (`v7_height`, a chain constant, kept for good once
  // read); without it, no ECX payout is paired.
  let instantFrom: number | undefined;
  let statusError: unknown;
  if (read.some((r) => r !== undefined && r.ecxPayouts.length > 0)) {
    const kept = await caches.store?.get<{ instantPayoutsFrom?: unknown }>(statusKey);
    if (typeof kept?.instantPayoutsFrom === "number") instantFrom = kept.instantPayoutsFrom;
    else {
      try {
        instantFrom = (await market()).instantPayoutsFrom;
        if (instantFrom !== undefined) await caches.store?.set(statusKey, { instantPayoutsFrom: instantFrom });
      } catch (error) {
        statusError = error;
      }
    }
  }

  // Pair ECX payouts with coinbase outputs, oldest trade first (the node pays its queue in order), own-block ones before.
  const coinbases = [...txs.values()].filter((tx) => tx.status.confirmed && isCoinbase(tx)).sort((x, y) => x.status.blockHeight! - y.status.blockHeight!);
  const claimed = new Set<string>();
  const folded = new Map<string, bigint>();
  const ownBlock = (height: number) => instantFrom !== undefined && height >= instantFrom;
  const pair = (height: number, chnTo: string, amount: string): PayoutState => {
    const match = coinbases
      .filter((cb) => (ownBlock(height) ? cb.status.blockHeight === height : cb.status.blockHeight! >= height))
      .flatMap((cb) => cb.vout.map((o, vout) => ({ cb, o, vout })))
      .find(({ cb, o, vout }) => o.scriptpubkey === chnTo && String(o.value) === amount && !claimed.has(`${cb.txid}:${vout}`));
    if (match === undefined) return "queued";
    claimed.add(`${match.cb.txid}:${match.vout}`);
    folded.set(match.cb.txid, (folded.get(match.cb.txid) ?? 0n) + BigInt(amount));
    const { blockTime } = match.cb.status;
    return { txid: match.cb.txid, ...(blockTime === undefined ? {} : { time: blockTime }) };
  };
  const outcomes: (TradeOutcome | undefined)[] = read.map((r) => r?.outcome);
  // Trades paid in their own block first: an older trade's looser rule mustn't take a payout that can only be theirs.
  const height = (i: number) => trades[i].tx.status.blockHeight ?? Infinity;
  const byHeight = trades.map((_, i) => i).sort((i, j) => Number(ownBlock(height(j))) - Number(ownBlock(height(i))) || height(i) - height(j));
  for (const i of byHeight) {
    const r = read[i];
    if (r === undefined || !("back" in r.outcome) || r.ecxPayouts.length === 0) continue;
    if (statusError !== undefined) {
      outcomes[i] = unknown(statusError);
      continue;
    }
    const { tx, order } = trades[i];
    let outcome = r.outcome;
    for (const payout of r.ecxPayouts) {
      const state = pair(tx.status.blockHeight!, order.chnTo, payout.amount);
      outcome = payout.what === "back" ? { ...outcome, returned: { amount: payout.amount, payout: state } } : { ...outcome, payout: state };
    }
    outcomes[i] = outcome;
  }

  const tradeAt = new Map(trades.map((t, i) => [t.entry.txid, i]));
  const paidOut = (state: PayoutState | undefined, amount: string) => (typeof state === "object" ? BigInt(amount) : 0n);
  return entries.flatMap((entry): HistoryEntry[] => {
    const i = tradeAt.get(entry.txid);
    const outcome = i === undefined ? undefined : outcomes[i];
    if (i !== undefined && outcome !== undefined) {
      const { order, fee } = trades[i];
      const ecxBack = "back" in outcome ? paidOut(outcome.payout, outcome.back.amount) + (outcome.returned ? paidOut(outcome.returned.payout, outcome.returned.amount) : 0n) : 0n;
      return [{ ...entry, amounts: add(entry.amounts, NATIVE_COIN, ecxBack), trade: { pools: order.pools, given: { asset: assetOf(order.assetIn), amount: order.amountIn }, fee: fee.toString(), outcome } }];
    }
    // A coinbase whose outputs to the wallet all paid trades leaves the list; otherwise what's left shows.
    const folds = folded.get(entry.txid);
    if (folds === undefined) return [entry];
    const amounts = add(entry.amounts, NATIVE_COIN, -folds);
    return amounts.length === 0 ? [] : [{ ...entry, amounts }];
  });
}

/** An answer this wallet kept: an older one (ADR 0017's `{ filled }` or `{ missed }`) is asked again. */
const isAnswer = (kept: unknown): kept is Answer => {
  if (typeof kept !== "object" || kept === null) return false;
  const { none, status, height, payouts } = kept as Record<string, unknown>;
  return none === true || ((status === "filled" || status === "missed") && typeof height === "number" && Array.isArray(payouts));
};

const unknown = (error: unknown): TradeOutcome => ({ state: "unknown", error: error instanceof Error ? error.message : String(error) });

/** `amounts` with `delta` added to `asset`, dropping what nets to zero. */
function add(amounts: AssetAmount[], asset: string, delta: bigint): AssetAmount[] {
  if (delta === 0n) return amounts;
  const net = new Map(amounts.map((a) => [a.asset, BigInt(a.amount)]));
  net.set(asset, (net.get(asset) ?? 0n) + delta);
  return [...net].filter(([, amount]) => amount !== 0n).map(([a, amount]) => ({ asset: a, amount: amount.toString() }));
}
