# Flush tokens are read from the transactions that made them, and named from their registration

Flush (#58) carries tokens on outputs of value 0, and its explorer lists them like any other output: `/address/:a/utxo` has no `asset` field. Only the `BAST` marker of the transaction that created an output says what it carries. A marker lists each token output with its token (kind, id, amount), or as a **result**: the output of a swap, a pool withdrawal and the like, whose token only the node's state knows. A light client can't compute results: every swap in a block clears at one price after the block's last transaction, and a missed order is refunded in what it paid (#58, round 3).

So Flush's module declares a `tokens` capability with two calls (`core/flush/src/tokens.rs`):

- **`outputTokens(tx)`:** the raw transaction (hex) → its txid, as the module computes it, and every output its marker lists with its token, or as a result. The marker is parsed exactly as the node reads it (`core/flush/src/bast.rs`, backbone-flush `release-slot99-v5`).
- **`assetRegistration(asset, tx)`:** an asset's ticker, name and decimals, only if `tx` registers that very id under a ticker whose SHA-256 is the id (`HashName`). A launch registers its token too.

## Balances

Over the `flush` Server API (ADR 0012), the Esplora client reads every value-0 coin's creating transaction (`/tx/:txid/hex`, cached for the session) and asks the module what it carries. The txid the module computes must be the coin's, so a server can't pass one transaction off as another. Then:

- An `asset` token counts towards that asset's balance, confirmed or unconfirmed like any coin.
- Other token kinds (a control coin, LP shares, a position, an order, a receipt or a reservation) don't count: they aren't amounts of an asset. None is ever spent: coin selection takes only value>0 coins.
- A **result** isn't in the balance the wallet read itself. For an address holding one, the client asks `/flush/market/addresses/:a/holdings` and reports what it says beyond the address's readable tokens as **`unverified`**. Screens show that part apart, marked "reported by its server".

## Names (asset store source `registration`)

A token whose id neither the Chain Entry nor the asset store names shows as "Unknown asset", as on Elements. Its "Name it" form on Flush offers **its registration** in place of a contract. `getasset` (`/flush/rpc/getasset`) says which transaction registered the asset and at what height. The wallet checks that the transaction is confirmed, and the module checks it is that asset's registration. The asset store keeps the result with `source: "registration"`, marked "from its registration" (ADR 0010's rules apply: no colliding tickers, the Chain Entry wins).

What this proves: the ticker and the decimals are the asset's own, since consensus binds an id to its ticker's hash. The display name is the one the registration set. The asset's controller can change it later (`SetDisplayName`), and the wallet doesn't follow that.

## Considered Options

- **Use `holdings` for every token balance:** rejected. It is the server's word on every amount; reading markers makes most of them the chain's.
- **Ask the server per outpoint:** no such route exists (asked of Flush's developer on 2026-10-25).
- **Name tokens automatically, without the user asking:** not for now. On Elements, naming takes the user's action (ADR 0010), and the screens already lead to "Name it". It would also need the Home list to learn new names mid-session.
- **Trust `getasset`'s ticker and decimals:** rejected. The server could name any asset anything; the registration transaction can't be forged into another asset's.
- **Prove the registration is current:** not possible from a light client. A released ticker can be registered again under the same id, and only node state shows the release. Consensus refuses a release while any output carries the asset, so while the wallet holds the asset, a registration older than the coin can only have been replaced by one between them. The store keeps the registration's txid, so a later check can tell if `getasset` names another.

## Consequences

- `flush.wasm` declares `tokens`. The wallet asks a module for tokens only when it declares them.
- Reading a balance on Flush costs one transaction fetch per value-0 coin the session hasn't seen, and one `holdings` call per address holding a result.
- Sending tokens is #59. It needs per-outpoint tokens for every input, so results can't be spent until a server reports them per outpoint.
