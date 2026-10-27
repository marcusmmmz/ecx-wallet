# Flush DEX actions: `window.flush` is a shim, and the wallet builds the action

flush.markets finds a wallet only through an injected `window.flush` (`isFlush`, `flush_requestAddress`, `flush_submit({ uri })`); it never looks for our Provider. Its `flush:` URI is an **Action**, not a transaction (`doc/flush-links.md`, `doc/public-api.md` in backbone-flush): the wallet builds the transaction from its own coins, checks the floor against its own quote, signs and broadcasts. That is ADR 0006's model, so an Action is built the way `sendTransfer` builds a Send.

- **`window.flush` is a shim over the Provider**, injected on every page like the Provider, unless a page already has a `window.flush` (another wallet's): then we leave it alone. `flush_requestAddress` is `getAddresses` on the active network's Flush Slot (Slot 99 on betanet, ADR 0014), answering its given-out address (ADR 0007); a network without a Flush chain refuses it. `flush_submit({ uri })` is `sendAction`.
- **`sendAction({ slot, action })` is chain-neutral.** The Slot's Chain Module defines what an `action` is; on Flush it is the `flush:` URI. The answer is `{ txid }`. `sendTransfer` stays outputs only, so its rule (the payments asked for, plus outputs back to the wallet) keeps holding.
- **One Grant.** A Grant for `sendTransfer` also covers `sendAction`: both let an app have the wallet build and send a transaction, and the user approves each one in a Clear View. The Grant decides only who may ask.
- **Swaps only, for now.** Any other Flush action (liquidity, orders, launches, auctions, …) is refused with 4200 before a window opens.
- **The wallet's own quote, or no swap.** The Chain Module quotes with the node's `getswapquote` (through the explorer's `/flush/rpc/`), which covers regular pools and launch curves before and after graduation. It refuses (-32602) when the pair has no pool, when the Action's floor is more than 10% below the quote, or when the Action has expired; when the explorer can't quote (a 501 or 503), it answers -32001, so the app can tell "try later" from "won't build". Quotes come back in decimals and are compared in base units.
- **Built means Clear.** As in ADR 0006, a Blind result is a wallet bug and is refused, Blind opt-in or not. A swap whose result, receipt or `chn_to` pays anyone but the wallet, or that burns anything the Action didn't name as its cost, is refused before the user sees it.
- **The Clear View** reads: Swap on Flush, from the app's origin; Pay (the asset in, with its badge, ADR 0015); Receive at least (the floor, with its badge, and our quote below); To your address; Expires (block and estimated time); the network fee and the ECX the marker locks. The result is reported by the server, so it shows as a floor, never as an exact amount.
- **Broadcast with `maxburnamount`.** The node refuses value in an `OP_RETURN` unless allowed, and a swap's marker locks ECX there. A DEX broadcast passes `POST /tx?maxburnamount=` the marker's ECX exactly, so the node refuses any burn larger than the one approved. Other broadcasts don't pass it.
- **No `check_code` yet.** `flush_submit` passes only the URI, so the wallet can't compute the code the site shows. It will show it once flush.markets passes the payload and `quote_height`.

DEX markers in transactions the wallet didn't build (a `signTransaction` request) are decoded, not built: the Clear View names the action, lists its explicit token outputs as yours or someone else's, flags result outputs as known only to the server, and warns, rather than refuses, on the shapes above. A kind whose fields the Decoder can't fully explain is Blind and named.

## Considered options

- **No `window.flush`; ask flush.markets to support our Provider:** rejected. Nothing would work until they did.
- **A Flush-only provider with its own permissions:** rejected. It would duplicate Grants and the approval window for one chain.
- **A separate Grant for `sendAction`:** rejected. Each Action is approved in its own Clear View, so a second Grant would guard the same power twice.
- **Actions as a new `to` in `sendTransfer`:** rejected. It would break `sendTransfer`'s rule that the transaction is exactly the outputs asked for.
- **Quote ourselves from pool reserves:** rejected. We'd have to reproduce every curve's maths, which could drift from the node's without anyone noticing.
- **Trust the Action's floor:** rejected. A phishing site could set a floor of one base unit, and the Clear View would show it faithfully.
- **Warn on phishing shapes when building:** rejected. A swap paying its result to someone else is never what a user means.
- **A `check_code` computed from the URI:** rejected. A code that never matches the site's would teach users to ignore mismatches.

## Consequences

- Swaps fail closed while the explorer can't quote (a 501 or 503 from `/flush/rpc/`).
- A site that sees another wallet's `window.flush` won't see ours; the user picks that wallet or removes it.
- Gaps, each for a later issue: building other DEX actions; the `check_code`, once `flush_submit` passes the payload; staking (#61).
