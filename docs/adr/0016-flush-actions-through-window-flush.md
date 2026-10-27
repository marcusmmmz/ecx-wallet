# Flush DEX actions: `window.flush` is a shim, and the wallet builds the action

flush.markets finds a wallet only through an injected `window.flush` (`isFlush`, `flush_requestAddress`, `flush_submit({ uri })`); it never looks for our Provider. Its `flush:` URI is an **Action**, not a transaction (`doc/flush-links.md`, `doc/public-api.md` in backbone-flush): the wallet builds the transaction from its own coins, checks the floor against its own quote, signs and broadcasts. That is ADR 0006's model, so an Action is built the way `sendTransfer` builds a Send.

- **`window.flush` is a shim over the Provider**, injected on every page like the Provider, unless a page already has a `window.flush` (another wallet's): then we leave it alone. `flush_requestAddress` is `getAddresses` on the active network's Flush Slot (Slot 99 on betanet, ADR 0014), answering its given-out address (ADR 0007); a network without a Flush chain refuses it. `flush_submit({ uri })` is `sendAction`.
- **`sendAction({ slot, action })` is chain-neutral.** The Slot's Chain Module defines what an `action` is; on Flush it is the `flush:` URI. The answer is `{ txid }`. `sendTransfer` stays outputs only, so its rule (the payments asked for, plus outputs back to the wallet) keeps holding.
- **One Grant.** A Grant for `sendTransfer` also covers `sendAction`: both let an app have the wallet build and send a transaction, and the user approves each one in a Clear View. The Grant decides only who may ask.
- **Trades only, for now:** `swap` (a pool, by id), and `buy` and `sell` (a launch curve, not graduated). Every pool on betanet is a launch curve, so a swap alone would leave nothing to trade. Any other Flush action (liquidity, orders, launches, auctions, …) is refused with 4200 before a window opens.
- **The link as flush.markets writes it.** `v=1`, its `network` the Slot's (`ecashbeta` on betanet), and `exp` a Unix time not past (two minutes of clock difference forgiven) and at most a day ahead. A link that already ran is refused for the rest of the session: its SHA-256 is kept in `storage.session`, so a trade link left in the browser's history can't run twice within its `exp`. Each of these refusals is -32602.
- **The wallet's own quote, or no trade.** The Chain Module quotes with the node's `getswapquote` (through the explorer's `/flush/rpc/`), which covers regular pools and launch curves before and after graduation. It refuses (-32602) when the pair has no pool, or when the Action's floor is more than 10% below the quote; when the explorer can't quote (a 501 or 503), it answers -32001, so the app can tell "try later" from "won't build". Quotes come back in decimals and are compared in base units.
- **One marker for the three trades.** Like Flush's own wallet, the module builds each as a `swap_pools` marker (kind 21) through the link's one pool: the outputs it lists first (change of the token paid in, if any, then one result output), then the marker carrying the ECX paid in, then ECX change. The result, token change and `chn_to` (ECX paid out or refunded) go to the given-out address, which the site knows; ECX change goes to a change address, and the fee rate is Send's (ADR 0006).
- **The pool proven, not reported.** A kind-21 marker never names what comes out: the pool's other asset does. So the module recomputes the pool's id from the parameters the explorer reports (`getpool`: its two assets, curve, fee, amp, weight, flags) and refuses unless it is the link's; the pool's assets must be the link's `from` and `to` (or ECX and the launch's token), each ticker the hash of its id. Each token's decimals come from its registration transaction (`getasset`'s `registration`), checked as ADR 0013 checks a name, never from the explorer's word: a wrong number of places would spend a multiple of what the Clear View shows. Amounts paid must fit their asset's places exactly; a floor is rounded up to them. Below the least ECX the node pays out (`getbitassetsinfo.min_chn_payout`), a buy or a sale's floor is refused.
- **Built means Clear.** As in ADR 0006, a Blind result is a wallet bug and is refused, Blind opt-in or not. A trade whose result, receipt or `chn_to` pays anyone but the wallet, or that burns anything the Action didn't name as its cost, is refused before the user sees it.
- **The Clear View** reads: Swap, Buy or Sell on Flush, from the app's origin; Pay (the asset in, with its badge, ADR 0015); Receive at least (the floor, with its badge, and our quote below); To your address; Expires (the link's `exp`, as a local time); the network fee and the ECX the marker locks. The result is reported by the server, so it shows as a floor, never as an exact amount.
- **Broadcast with `maxburnamount`.** The node refuses value in an `OP_RETURN` unless allowed, and a trade's marker locks ECX there. A DEX broadcast passes `POST /tx?maxburnamount=` the marker's ECX exactly, so the node refuses any burn larger than the one approved. Other broadcasts don't pass it.
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

- Trades fail closed while the explorer can't quote (a 501 or 503 from `/flush/rpc/`).
- A ticker released and registered again keeps its id (ADR 0013), so an explorer could hand over the older registration, with other decimals. Accepted for now: it needs a ticker re-registered with different places.
- A link replayed after the browser restarts, within its `exp`, is asked again; the node's own floor still binds it.
- A site that sees another wallet's `window.flush` won't see ours; the user picks that wallet or removes it.
- Gaps, each for a later issue: building other DEX actions; the `check_code`, once `flush_submit` passes the payload; staking (#61).
