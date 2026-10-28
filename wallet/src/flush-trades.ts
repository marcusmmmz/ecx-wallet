// Flush trades in history (docs/adr/0017). A trade through one pool (kind 21) says what it pays in;
// what comes out is only in the node's state. The node's DEX API lists each fill (`poolTrades`), and
// none for a trade that missed. ECX coming out, or an ECX refund, is paid by a later coinbase to the
// order's `chn_to`, one output per trade of exactly that amount, in queue order; nothing on the chain
// names the trade. So the wallet pairs each trade with the earliest unclaimed coinbase output to its
// `chn_to` of the amount expected, at or after its block, and folds it into the trade's entry.
import { cacheKey, type SessionCache } from "./cache";
import { NATIVE_COIN, type AssetAmount, type OutputTokens, type SwapOrder } from "./chain-module";
import { isCoinbase, type EsploraClient, type EsploraTx, type PoolTrade } from "./esplora";
import type { HistoryEntry, TradeOutcome } from "./sidechain-server";

/** The most pages of a pool's trades read to find one: 1,000 trades, newest first. */
const MAX_TRADE_PAGES = 10;

/** What the market index said of a trade: the amount it filled with, or nothing listed (a miss). */
type Answer = { filled: string } | { missed: true };

/** Where answers are kept for good: only for trades in a final block, which no reorg can undo. */
export type TradeStore = Pick<SessionCache, "get" | "set">;

/** Flush writes ECX as the null hash; the wallet as NATIVE_COIN. */
const assetOf = (id: string) => (/^0{64}$/.test(id) ? NATIVE_COIN : id);

/**
 * Each of `entries` with its trade, if it is one: a kind-21 order through one pool, funded by the
 * wallet alone (so its fee is known), paying ECX to one of `ours`. Its payout's entry is folded in.
 */
export async function withTrades(
  entries: HistoryEntry[],
  txs: Map<string, EsploraTx>,
  markers: Map<string, OutputTokens | undefined>,
  ours: Set<string>,
  client: Pick<EsploraClient, "marketHeight" | "poolTrades" | "flushRpc" | "url">,
  caches: { session?: SessionCache; store?: TradeStore },
): Promise<HistoryEntry[]> {
  const trades = entries.flatMap((entry) => {
    const tx = txs.get(entry.txid)!;
    const order = markers.get(entry.txid)?.swap;
    if (order === undefined || order.pools.length !== 1 || !ours.has(order.chnTo)) return [];
    if (!tx.vin.every(({ prevout }) => prevout !== null && ours.has(prevout.scriptpubkey) && prevout.value !== undefined)) return [];
    const fee = tx.vin.reduce((sum, { prevout }) => sum + BigInt(prevout!.value!), 0n) - tx.vout.reduce((sum, o) => sum + BigInt(o.value ?? 0), 0n);
    return [{ entry, tx, order, fee }];
  });
  if (trades.length === 0) return entries;

  // Answers, for the session or for good, then the market index for the rest.
  let indexed: Promise<number> | undefined;
  const pages = new Map<string, Promise<{ trades: PoolTrade[]; next?: string }>>();
  const page = (pool: string, cursor?: string) => {
    const key = `${pool}:${cursor ?? ""}`;
    if (!pages.has(key)) pages.set(key, client.poolTrades(pool, cursor));
    return pages.get(key)!;
  };
  const poolAssets = new Map<string, Promise<[string, string]>>();
  const assetsOf = (pool: string) => {
    if (!poolAssets.has(pool)) {
      poolAssets.set(
        pool,
        client.flushRpc("getpool", [pool]).then((answer) => {
          const { asset_a_id: a, asset_b_id: b } = (answer ?? {}) as Record<string, unknown>;
          if (typeof a !== "string" || typeof b !== "string") throw new Error(`The server doesn't describe pool ${pool}.`);
          return [assetOf(a.toLowerCase()), assetOf(b.toLowerCase())];
        }),
      );
    }
    return poolAssets.get(pool)!;
  };
  // For good: under its own prefix, so locking (which forgets the session's cache) keeps it.
  const key = (txid: string) => `trade:${client.url}:${txid}`;

  async function answer(tx: EsploraTx, pool: string): Promise<Answer | "settling"> {
    const sessionKey = cacheKey.trade(client.url, tx.txid, tx.status.blockHash!);
    const kept = (await caches.store?.get<Answer>(key(tx.txid))) ?? (await caches.session?.get<Answer>(sessionKey));
    if (kept !== undefined) return kept;
    const height = tx.status.blockHeight!;
    if ((await (indexed ??= client.marketHeight())) < height) return "settling";
    let found: Answer = { missed: true };
    let cursor: string | undefined;
    for (let read = 0; ; read++) {
      if (read === MAX_TRADE_PAGES) throw new Error(`Pool ${pool} has too many trades since this one to find it.`);
      const { trades: listed, next } = await page(pool, cursor);
      const fill = listed.find((t) => t.txid === tx.txid);
      if (fill !== undefined) {
        found = { filled: fill.amountOut };
        break;
      }
      if (next === undefined || listed.length === 0 || listed.at(-1)!.height < height) break;
      cursor = next;
    }
    await caches.session?.set(sessionKey, found);
    if (tx.status.final) await caches.store?.set(key(tx.txid), found);
    return found;
  }

  const outcomes = await Promise.all(
    trades.map(async ({ tx, order }): Promise<TradeOutcome> => {
      if (!tx.status.confirmed) return { state: "settling" };
      try {
        const [pool] = order.pools;
        const said = await answer(tx, pool);
        if (said === "settling") return { state: "settling" };
        const assetIn = assetOf(order.assetIn);
        if ("missed" in said) return { state: "missed", back: { asset: assetIn, amount: order.amountIn } };
        const [a, b] = await assetsOf(pool);
        return { state: "filled", back: { asset: assetIn === a ? b : a, amount: said.filled } };
      } catch (error) {
        return { state: "unknown", error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );

  // Pair ECX coming back with coinbase outputs, oldest trade first: the node pays its queue in order.
  const coinbases = [...txs.values()].filter((tx) => tx.status.confirmed && isCoinbase(tx)).sort((x, y) => x.status.blockHeight! - y.status.blockHeight!);
  const claimed = new Set<string>();
  const folded = new Map<string, bigint>();
  const byHeight = trades.map((t, i) => i).sort((i, j) => (trades[i].tx.status.blockHeight ?? Infinity) - (trades[j].tx.status.blockHeight ?? Infinity));
  for (const i of byHeight) {
    const outcome = outcomes[i];
    if (!("back" in outcome) || outcome.back.asset !== NATIVE_COIN) continue;
    const { tx, order } = trades[i];
    const match = coinbases
      .filter((cb) => cb.status.blockHeight! >= tx.status.blockHeight!)
      .flatMap((cb) => cb.vout.map((o, vout) => ({ cb, o, vout })))
      .find(({ cb, o, vout }) => o.scriptpubkey === order.chnTo && String(o.value) === outcome.back.amount && !claimed.has(`${cb.txid}:${vout}`));
    if (match === undefined) {
      outcomes[i] = { ...outcome, payout: "queued" };
      continue;
    }
    claimed.add(`${match.cb.txid}:${match.vout}`);
    folded.set(match.cb.txid, (folded.get(match.cb.txid) ?? 0n) + BigInt(match.o.value!));
    const { blockTime } = match.cb.status;
    outcomes[i] = { ...outcome, payout: { txid: match.cb.txid, ...(blockTime === undefined ? {} : { time: blockTime }) } };
  }

  const tradeAt = new Map(trades.map((t, i) => [t.entry.txid, i]));
  return entries.flatMap((entry) => {
    const i = tradeAt.get(entry.txid);
    if (i !== undefined) {
      const { order, fee } = trades[i];
      const outcome = outcomes[i];
      const paid = "payout" in outcome && typeof outcome.payout === "object" ? BigInt(outcome.back.amount) : 0n;
      return [{ ...entry, amounts: add(entry.amounts, NATIVE_COIN, paid), trade: { pool: order.pools[0], given: { asset: assetOf(order.assetIn), amount: order.amountIn }, fee: fee.toString(), outcome } }];
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
