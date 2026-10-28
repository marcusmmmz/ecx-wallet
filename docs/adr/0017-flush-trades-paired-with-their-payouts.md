# Flush trades in history: the market index for the outcome, and the payout paired by amount

A Flush trade (kind 21, `swap_pools`) says what it pays in, never what comes out. Swaps clear at the end of their block, and what comes out is only in the node's state (backbone-flush `release-slot99-v5`, `bitassets/state.cpp`, researched on #60):

| | ECX by coinbase, to the order's `chn_to` | Token on the trade's result output |
|---|---|---|
| Sale, filled | the cleared amount (at least `min_out`) | none |
| Sale, missed | none | `amount_in` back |
| Buy, filled | none | the bought amount |
| Buy, missed | exactly `amount_in` | none |

The node pays ECX from a queue, one coinbase output per trade, of the exact amount and in order. The output may come in a later block than the trade's. Nothing in the coinbase names the trade. The node's DEX API (`/flush/market/pools/:id/trades`) lists each fill, with its txid and `amount_out_units`, but no misses. It can't be asked by txid or by address.

So the wallet reads a trade's outcome from the market index and pairs its ECX with a coinbase output:

- **Which trades:** a kind-21 order through one pool, funded by the wallet alone (so its fee is known), whose `chn_to` is one of the wallet's addresses. The module's `outputTokens` returns the order (`swap`) with the outputs it lists, so it costs no extra fetch: history already reads every trade, since a trade pays the wallet a value-0 result output.
- **Outcome:** a fill listed for its txid is **filled**, with `amount_out` of the pool's other asset (`getpool`). No fill, once the index has reached the trade's block (`/flush/market/status`), is **missed**, and what was paid in comes back. Until then it is **settling**. An index that can't be read makes it **unknown**, never missed. The answer is the server's word: screens underline it dotted until a coinbase pays it exactly.
- **Pairing:** ECX coming back (a fill out of ECX, or a missed buy's refund) is the earliest coinbase output, not already claimed, that pays `chn_to` exactly that amount in a block at or after the trade's. Trades are paired oldest first, as the node pays its queue. The output is folded into the trade's History Entry (`amounts` nets both), and a coinbase left with nothing else for the wallet leaves the list. With no such output yet, the payout is **queued**. A payout is always newer than its trade, so if the trade is in the pages history read, its payout is too once paid.
- **Caching:** the index's answer is cached for the session, by the trade's block (a soft one can be replaced, and the trade mined again elsewhere), and kept for good (plain `storage.local`, like pending Deposits) once the trade's block is `final`, which no reorg can undo. Pages of a pool's trades aren't cached: its first page grows, and a stale one would pass a new trade off as missed.
- **Activity:** a trade is one row twice as tall: what it gave above (in red), what came back below. Beside them, the asset given, a down arrow and the asset back. Chosen from three prototypes (branch `prototype/flush-trade-rows`).

## Considered options

- **Two rows, the payout relabelled and linked to its trade:** rejected (Q1). A queued payout can land in another day's section, away from its trade.
- **Guessing the fill from coinbases alone** (the earliest output to `chn_to` of at least `min_out`): rejected. Every other payout to that address (liquidity, positions, orders, Deposits) could pass for it, and it can't show what a buy received.
- **The explorer's decoded `operation`** (`/flush/tx/:txid`) for the order: rejected. It is the server's word for what the transaction itself proves (ADR 0013).
- **`gettxout`'s `token` for a result:** not reachable. The explorer's `/flush/rpc` refuses `gettxout`. The Flush dev is adding `trades/{txid}` in 8.2.0 (said 2026-10-27): its route, each hop's pool, kind and amounts in and out, and the ECX given back when a launch-curve buy reaches the curve's end. With it, the paging goes, and a launch buy's ECX back can be paired. Whether it reports misses wasn't said; until it does, the miss rule stays.

## Consequences

- A filled buy's tokens, a missed sale's returned tokens and a queued payout's amount are the market index's word. Only a coinbase paying exactly the expected amount backs a fill with the chain.
- If the index reports an amount no coinbase pays, the payout stays queued, and the coinbase stays its own "Received" entry. Pairing never relaxes the exact amount.
- Exact-amount pairing still has a narrow form of the risk rejected below: another coinbase paying `chn_to` exactly the expected amount (a Deposit's credit, a liquidity or order payout) at or after the trade's block can be taken for its payout. The amounts then match, so only the payout's txid and time can be wrong. Two more cases do the same: a trade whose outcome is unknown claims nothing, so a later one expecting the same amount can take its payout; and trades in one block pair in the order history lists them, not their order in the block, which only matters between equal amounts. The coinbase left over shows as its own "Received" entry.
- A launch buy's ECX change paid back through a coinbase isn't paired: the index doesn't report it yet (`trades/{txid}` will, from 8.2.0), so it stays a "Received" entry.
- Trades through more than one pool, and other operations that pay ECX by coinbase (liquidity, positions, orders, Collect), aren't paired: they show as their own transactions.
- A trade costs one `getpool` and the pages of its pool's trades back to its block (100 a page, at most 10) until its block is final, then nothing.
- Every Activity row now carries its asset marks and shows what left the wallet in red.
