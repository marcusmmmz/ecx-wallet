# Flush trade outcomes by txid, and payouts paired in the trade's own block

Supersedes ADR 0017's outcome, pairing and scope rules (#68). ADR 0017's Activity layout and caching stand.

Flush 8.2.0 (backbone-flush `flush-betanet`, `9cc49a8`) gives the node's DEX API an order's outcome by its transaction: `/flush/market/trades/:txid`. Checked live on the wallet's own server on 2026-10-28 with the BROSEVELT sale (`8010b040…`):

- **It reports misses.** `status` is `filled` or `missed`. A 404 means the index knows no order by that txid (`doc/public-api.md`, "Orders' outcomes").
- **It names the route and what was paid.** `swap.hops` gives each pool. `swap.payouts` gives what came out: `out` (a fill), `refund` (a miss's) and `back` (a launch buy's ECX past the curve's end), each with its asset, amount and `via`. ECX goes `via: "coinbase"` to the order's `chn_to`, with `outpoint: null`, so the wallet still finds the output itself.
- **ECX is paid in the trade's own block.** The docs say "by the coinbase of that block". Payouts have been instant from `v7_height` (18,980, in `/flush/market/status`'s `launch_params`). Block 24546 holds the BROSEVELT sale, and its coinbase's output 1 pays exactly 1,210,289 to the sale's `chn_to`.

So:

- **Outcome:** asked once per trade, by txid. The index's answer stands until the trade's block changes (the session cache is keyed by block), and for good once the block is `final`. Until the index has reached the trade's block (`/flush/market/status`) the trade is **settling**. Past that height, a 404 means the transaction is no order the index knows, and it shows as a plain transaction. An answer that can't be read makes the trade **unknown**, and so does a market status that can't be read when the trade has ECX to pair: without `v7_height`, the wallet can't tell which block may pay it. A trade with no ECX to pair (its tokens come back on its result) still shows its outcome.
- **Pairing:** each ECX payout the index reports (`out` or `refund`, and `back`) is paired with an unclaimed coinbase output paying `chn_to` exactly that amount. From `v7_height` the output must be in the trade's own block; before it, in a block at or after the trade's, as in ADR 0017. Trades are still paired oldest first.
- **Which trades:** a kind-21 order through any number of pools, funded by the wallet alone (so its fee is known), whose `chn_to` is one of the wallet's addresses. A trade's entry lists its pools (`pools`), from its own marker: the transaction's word, where the index's `swap.hops` is the server's. A launch buy's ECX back is `returned` on its outcome, folded into the entry like the payout.

## Considered options

- **`addresses/{a}/trades`, one paged list per watched address:** rejected. Every refresh would ask about every watched address, most of which never traded. History already finds each trade, so asking by txid costs one call per trade, and none once its block is final.
- **Trust a 404 at once:** rejected. `/status` reports `indexer_lag`, so the index can trail the chain, and a fresh trade would briefly look like no trade.
- **Keep pairing at or after the trade's block:** rejected from `v7_height`. The node pays in the trade's block, so a later coinbase of the same amount (a Deposit's credit, another payout) can only be someone else's.

## Consequences

- Pool paging, `MAX_TRADE_PAGES`, the miss rule and `getpool` for a trade's assets are gone. The stub server answers `/flush/market/trades/:txid` instead of a pool's trades.
- ADR 0017's remaining pairing risk is narrower. Only a coinbase output in the trade's own block, to the same address and of the same amount, can be taken for its payout, and then only its txid and time can be wrong.
- A trade whose txid the index doesn't know is shown as an ordinary transaction, not as a trade that went wrong.
- Answers kept for good by ADR 0017's wallet (`{ filled }` or `{ missed }`, under the same `trade:<server>:<txid>` key) aren't this one's: they're asked again once, and kept in the new shape.
- Other operations that pay ECX by coinbase (liquidity, positions, orders, Collect) still aren't paired.
