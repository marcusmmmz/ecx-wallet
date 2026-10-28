// Flush trades in history (docs/adr/0017, 0018). A trade (kind 21) says what it pays in; what comes
// out is only in the node's state. The node's DEX API reports each order's outcome by its txid
// (`trades/{txid}`): filled or missed, and what it paid out. ECX is paid by a coinbase output to the
// order's `chn_to` of exactly that amount, which names no trade: from `v7_height`, the coinbase of
// the trade's own block. So the wallet pairs each ECX payout with the earliest unclaimed coinbase
// output to its `chn_to` of the amount reported, in that block (before `v7_height`, at or after it),
// and folds it into the trade's entry.
import { cacheKey, type SessionCache } from "./cache";
import { NATIVE_COIN, type AssetAmount, type OutputTokens } from "./chain-module";
import { isCoinbase, type EsploraClient, type EsploraTx, type MarketPayout, type MarketStatus, type MarketTrade } from "./esplora";
import type { HistoryEntry, TradeOutcome, TradePayout } from "./sidechain-server";

/** What the market index said of a transaction: its outcome, or that it knows no order by it. */
type Answer = MarketTrade | { none: true };

/** Where answers are kept for good: only for trades in a final block, which no reorg can undo. */
export type TradeStore = Pick<SessionCache, "get" | "set">;

/** Flush writes ECX as the null hash, or empty; the wallet as NATIVE_COIN. */
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

  /** The index's answer: kept for good, else for the session (by block: a soft one can be replaced), else asked. */
  async function answer(tx: EsploraTx): Promise<Answer | "settling"> {
    const sessionKey = cacheKey.trade(client.url, tx.txid, tx.status.blockHash!);
    const kept = (await caches.store?.get<Answer>(key(tx.txid))) ?? (await caches.session?.get<Answer>(sessionKey));
    if (kept !== undefined) return kept;
    // Until the index reaches the trade's block, it has no outcome: only past it does a 404 mean no order.
    if ((await market()).height < tx.status.blockHeight!) return "settling";
    const found: Answer = (await client.marketTrade(tx.txid)) ?? { none: true };
    await caches.session?.set(sessionKey, found);
    if (tx.status.final) await caches.store?.set(key(tx.txid), found);
    return found;
  }

  // Each trade's outcome, and the ECX payouts a coinbase pays it; undefined if the index knows no order by it.
  const outcomes = await Promise.all(
    trades.map(async ({ tx }): Promise<{ outcome: TradeOutcome; coinbase: MarketPayout[] } | undefined> => {
      if (!tx.status.confirmed) return { outcome: { state: "settling" }, coinbase: [] };
      try {
        const said = await answer(tx);
        if (said === "settling") return { outcome: { state: "settling" }, coinbase: [] };
        if ("none" in said) return undefined;
        const main = said.payouts.find((p) => p.what === (said.status === "filled" ? "out" : "refund"));
        if (main === undefined) throw new Error(`The market index reports no ${said.status === "filled" ? "payout" : "refund"} for it.`);
        const coinbase = said.payouts.filter((p) => p.via === "coinbase" && assetOf(p.asset) === NATIVE_COIN && (p === main || p.what === "back"));
        return { outcome: { state: said.status, back: { asset: assetOf(main.asset), amount: main.amount } }, coinbase };
      } catch (error) {
        return { outcome: { state: "unknown", error: error instanceof Error ? error.message : String(error) }, coinbase: [] };
      }
    }),
  );
  const instantFrom = outcomes.some((o) => o !== undefined && o.coinbase.length > 0) ? (await market()).instantPayoutsFrom : undefined;

  // Pair ECX payouts with coinbase outputs, oldest trade first: the node pays its queue in order.
  const coinbases = [...txs.values()].filter((tx) => tx.status.confirmed && isCoinbase(tx)).sort((x, y) => x.status.blockHeight! - y.status.blockHeight!);
  const claimed = new Set<string>();
  const folded = new Map<string, bigint>();
  const pair = (height: number, chnTo: string, amount: string): TradePayout | "queued" => {
    const ownBlock = instantFrom !== undefined && height >= instantFrom;
    const match = coinbases
      .filter((cb) => (ownBlock ? cb.status.blockHeight === height : cb.status.blockHeight! >= height))
      .flatMap((cb) => cb.vout.map((o, vout) => ({ cb, o, vout })))
      .find(({ cb, o, vout }) => o.scriptpubkey === chnTo && String(o.value) === amount && !claimed.has(`${cb.txid}:${vout}`));
    if (match === undefined) return "queued";
    claimed.add(`${match.cb.txid}:${match.vout}`);
    folded.set(match.cb.txid, (folded.get(match.cb.txid) ?? 0n) + BigInt(amount));
    const { blockTime } = match.cb.status;
    return { txid: match.cb.txid, ...(blockTime === undefined ? {} : { time: blockTime }) };
  };
  const byHeight = trades.map((_, i) => i).sort((i, j) => (trades[i].tx.status.blockHeight ?? Infinity) - (trades[j].tx.status.blockHeight ?? Infinity));
  for (const i of byHeight) {
    const said = outcomes[i];
    if (said === undefined || !("back" in said.outcome)) continue;
    const { tx, order } = trades[i];
    for (const payout of said.coinbase) {
      const paid = pair(tx.status.blockHeight!, order.chnTo, payout.amount);
      said.outcome = payout.what === "back" ? { ...said.outcome, returned: { amount: payout.amount, payout: paid } } : { ...said.outcome, payout: paid };
    }
  }

  const tradeAt = new Map(trades.map((t, i) => [t.entry.txid, i]));
  return entries.flatMap((entry): HistoryEntry[] => {
    const i = tradeAt.get(entry.txid);
    const said = i === undefined ? undefined : outcomes[i];
    if (i !== undefined && said !== undefined) {
      const { order, fee } = trades[i];
      const { outcome } = said;
      const paid = (p: TradePayout | "queued" | undefined, amount: string) => (typeof p === "object" ? BigInt(amount) : 0n);
      const back = "back" in outcome ? paid(outcome.payout, outcome.back.amount) + (outcome.returned ? paid(outcome.returned.payout, outcome.returned.amount) : 0n) : 0n;
      return [{ ...entry, amounts: add(entry.amounts, NATIVE_COIN, back), trade: { pools: order.pools, given: { asset: assetOf(order.assetIn), amount: order.amountIn }, fee: fee.toString(), outcome } }];
    }
    // A coinbase whose outputs to the wallet all paid trades leaves the list; otherwise what's left shows.
    const paid = folded.get(entry.txid);
    if (paid === undefined) return [entry];
    const amounts = add(entry.amounts, NATIVE_COIN, -paid);
    return amounts.length === 0 ? [] : [{ ...entry, amounts }];
  });
}

/** `amounts` with `delta` added to `asset`, dropping what nets to zero. */
function add(amounts: AssetAmount[], asset: string, delta: bigint): AssetAmount[] {
  if (delta === 0n) return amounts;
  const net = new Map(amounts.map((a) => [a.asset, BigInt(a.amount)]));
  net.set(asset, (net.get(asset) ?? 0n) + delta);
  return [...net].filter(([, amount]) => amount !== 0n).map(([a, amount]) => ({ asset: a, amount: amount.toString() }));
}
