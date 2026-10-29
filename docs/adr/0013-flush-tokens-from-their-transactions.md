# Flush tokens are read from the transactions that made them, and named from their registration

Flush (#58) carries tokens on outputs of value 0, and its explorer lists them like any other output: `/address/:a/utxo` has no `asset` field. Only the `BAST` marker of the transaction that created an output says what it carries. A marker lists each token output with its token (kind, id, amount), or as a **result**: the output of a swap, a pool withdrawal and the like, whose token only the node's state knows. A light client can't compute results: every swap in a block clears at one price after the block's last transaction, and a missed order is refunded in what it paid (#58, round 3).

So Flush's module declares a `tokens` capability with two calls (`core/flush/src/tokens.rs`):

- **`outputTokens(tx)`:** the raw transaction (hex) → its txid, as the module computes it, and every output its marker lists with the script it pays and its token, or as a result. A listed output counts for the wallet only if that script is one it watches. A marker listing an output that isn't of value 0, or whose script the node can't hold a token on (anything but P2PKH, P2SH, P2WPKH, P2WSH or P2TR: Flush Core's `Spendable`, else `bad-ba-token-output`), is refused, as the node refuses it. The marker is parsed exactly as the node reads it (`core/flush/src/bast.rs`, backbone-flush `flush-betanet` on betanet, `main` on mainnet).
- **`assetRegistration(asset, tx)`:** an asset's ticker, name and decimals, only if `tx` registers that very id under a ticker whose SHA-256 is the id (`HashName`). A launch registers its token too.

## Balances

Over the `flush` Server API (ADR 0012), the Esplora client reads every value-0 coin's creating transaction (`/tx/:txid/hex`, cached for the session) and asks the module what it carries. The txid the module computes must be the coin's, so a server can't pass one transaction off as another. Then:

- An `asset` token counts towards that asset's balance, confirmed or unconfirmed like any coin.
- Other token kinds (a control coin, LP shares, a position, an order, a receipt or a reservation) don't count: they aren't amounts of an asset. None is ever spent: coin selection takes only value>0 coins.
- A **result** isn't in the balance the wallet read itself. For an address holding one, the client asks `/flush/market/addresses/:a/holdings` and reports what it says beyond the address's readable tokens as **`unverified`**. Screens show that part apart, marked "reported by its server".
- **Amended 2026-10-28:** a result on an order's own transaction is named by the order's outcome (`trades/{txid}`, ADR 0018). Each token payout there (`via: "output"`) gives the outpoint it lands on. The wallet takes it only if it fits the order's marker: a fill pays another asset than went in, at least `min_out`; a miss refunds exactly the asset and amount that went in. Such a result counts in the balance, reported apart as **`indexed`** (the index's word, underlined dotted), and `holdings` is asked only if the address holds a result nothing named. It still can't be spent: the module would have to list its token from the index's word.
- **Amended 2026-10-29:** such a result can be spent, on the index's word, checked again by the module. Louis: "they are confirmed by PoS blocks already… We need to be able to spend them on flush from the wallet (assets)". Send offers a confirmed result the order's outcome names, with that word and each of the order's pools as `getpool` describes it (`result` on the coin). `build_transfer` (and `build_trade`) take it only if it fits the order its own transaction states: a fill pays the asset a walk from `asset_in` through the order's pools ends at (each pool's id recomputed from its description, as a trade's is), at least `min_out`; a miss refunds exactly `asset_in` and `amount_in`. The Decoder checks the same apart, from the request's evidence (`results`: outpoint, asset, amount, pools), so such a Send is Clear; without that evidence it stays Blind. Only a fill's exact amount is the index's alone, and a wrong one can't cost anything: a transfer must carry on exactly the tokens its inputs bring, or the node refuses it (`bad-ba-tokens-lost`, `bad-ba-tokens-unbacked`). A result whose pools the explorer can't describe, or that no outcome names, stays unspendable.

History Entries read tokens the same way (#60): each value-0 coin a transaction pays or spends of the wallet's counts as the asset token its creating transaction lists, so a token Send or a trade shows the tokens that moved. `holdings` can't say what one result held, only an address's current total, so an entry that pays or spends a result says only that it does (`results`): "+ amounts only the node knows not shown".

## Names (asset store source `registration`)

A token whose id neither the Chain Entry nor the asset store names is **named automatically** from its registration: when a report shows one, the app asks the background to name it (`assets.nameFromRegistrations`), once per asset per session. Until then, or if the check fails, it shows as "Unknown asset", whose "Name it" form on Flush offers its registration in place of a contract. `getasset` (`/flush/rpc/getasset`) says which transaction registered the asset and at what height. The wallet checks that the transaction is confirmed, and the module checks it is that asset's registration. The asset store keeps the result with `source: "registration"`, marked "from its registration" (ADR 0010's rules apply: no colliding tickers, the Chain Entry wins).

What this proves: the ticker and the decimals are the asset's own, since consensus binds an id to its ticker's hash. The display name is the one the registration set. The asset's controller can change it later (`SetDisplayName`), and the wallet doesn't follow that.

**Logos** are on chain too: a SetLogo (kind 32), or a registration with a logo, carries the whole image in its marker. `getasset` names the transaction that set the asset's logo (`logo.txid`, `logo.height`). The wallet checks that transaction is confirmed at that height, and the module's `assetLogo(asset, tx)` checks it sets this asset's logo and that the bytes are a PNG, JPEG, GIF or WebP image of at most 100 kB (never SVG). The store keeps it as a `data:` URL with the name. A logo that fails a check is left out; the name stands. Consensus lets only the asset's control coin set a logo, so the image is the controller's choice, as the display name is. A later SetLogo isn't followed, as with the display name. `/flush/logo/:asset` serves the same bytes, but only the server says they are the asset's, so the wallet doesn't use it.

The explorer's assets page (`/flush/assets`) lists the node's `listassets`, the same records as `getasset`, so it names nothing the registration doesn't.

## Sending tokens (#59)

A Send may pay an asset's tokens. The wallet offers the module its confirmed coins of value 0, each as the asset token its transaction lists on it (the mempool refuses a token spent unconfirmed, `ba-token-unconfirmed`). `build_transfer` reads each coin's token again from its transaction and spends only coins of the assets sent, largest first: never a control coin, LP shares, a position or an order, nor a result but one whose order's outcome names it (below). The outputs are the payments in order (a token's at value 0), each sent asset's change, a transfer marker (kind 0) listing every token output, then ECX change. ECX coins pay the fee.

The Decoder shows a transfer as a Clear View: each input and output in ECX or in the asset its token is, with the marker left out of the outputs, since its meaning is the tokens it lists. A request that spends a token of another kind, or a result its evidence doesn't name (`results`), or runs any other operation, is Blind. `check`, `decode` and `sign` refuse what Flush would refuse: a token output spent with no marker, a marker that doesn't parse, a transfer marker holding ECX or listing a result, and a transfer that doesn't carry on exactly the tokens its inputs spend.

## Considered Options

- **Use `holdings` for every token balance:** rejected. It is the server's word on every amount; reading markers makes most of them the chain's.
- **Ask the server per outpoint:** no such route exists (asked of Flush's developer on 2026-10-25).
- **Name tokens only when the user asks ("Name it"):** the first choice, replaced on 2026-10-27. Unlike an Elements contract, which anyone can write for any asset and which the user must pick, a Flush registration is the one the chain binds to the id, so the user's action added nothing but a step.
- **Trust `getasset`'s ticker and decimals:** rejected. The server could name any asset anything; the registration transaction can't be forged into another asset's.
- **Prove the registration is current:** not possible from a light client. A released ticker can be registered again under the same id, and only node state shows the release. Consensus refuses a release while any output carries the asset, so while the wallet holds the asset, a registration older than the coin can only have been replaced by one between them. The store keeps the registration's txid, so a later check can tell if `getasset` names another.

## Consequences

- `flush.wasm` declares `tokens`. The wallet asks a module for tokens only when it declares them.
- Reading a balance on Flush costs one transaction fetch per value-0 coin the session hasn't seen, and one `holdings` call per address holding a result.
- A result on an order's own transaction is spent on the market index's word (amended 2026-10-29). Any other result (a pool withdrawal's, or one no outcome names) still can't be: the module can't list its token again without knowing it.
- A request with a `BAST` marker that doesn't parse is refused before unlock, where it used to be Blind: Flush would refuse the transaction.
