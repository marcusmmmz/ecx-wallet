# The asset store: assets the wallet has checked contracts for

The wallet named only the assets its Chain Entry lists (ADR 0005). Any other asset showed as "Unknown asset" in base units, even one the wallet had just issued with a contract it checked at approval (ADR 0009): issuing `cdf6ff1e…c1bd4435` showed in Activity as "+6,942,000,000,000 Unknown asset".

The wallet now keeps one **asset store** per network, separate from the Chain Entry, in plain `storage.local` under `assets:<chain>` (the CAIP-2 id):

```json
{ "<asset id>": { "id": "…", "name": "Example Asset", "ticker": "EXA", "precision": 8, "domain": "dex.example", "source": "signed" } }
```

Screens look an asset up in the Chain Entry first, then in the store. `chains.list` hands them both, the store's after the Chain Entry's, so Home, Activity, Send and the approval window all name it the same way (`wallet/src/assets.ts`).

## Where a stored asset comes from (`source`)

- **`signed`:** the wallet signs a new issuance whose `evidence.assetContract` checked out, and stores the asset the Decoder derived, with the contract's name, ticker, precision and domain. Nothing is fetched. It's stored once `sign` succeeds, whether or not the requester broadcasts. Failing to store it doesn't fail the signature.
- **`contract`:** the user adds an asset by its contract (`assets.addByContract`). Esplora's `/asset/:id` reports the outpoint its issuance spent (`issuance_prevout`). The Slot's Chain Module derives the asset id from that outpoint and the SHA-256 of the contract's exact bytes, as consensus and the Decoder do. It must equal the asset asked for, and the contract must pass ADR 0009's registry rules (`assetContract` capability, `asset_contract` in `elements.wasm`). The server's `contract_hash` isn't used. A server can name any outpoint, but a wrong one derives another id: to make a different contract pass, it would need a second SHA-256 preimage. The store keeps that contract's exact JSON.
- **`app`:** a plain name an app suggested (`suggestAsset`) and the user approved, kept with the app's origin. An app's suggested contract is checked like the user's and stored as `contract`, also with the origin.
- **`label`:** the user's own name, ticker and precision for an asset with no contract. Its name and ticker follow the registry's rules for a contract's.

## Rules

- **No colliding tickers.** An entry whose ticker matches one of the Chain Entry's on that network, in any case, is refused whatever its source. So nothing shows as "ECX" but ECX, and the total across chains still counts only the Chain Entry's ECX. A signed issuance with such a ticker is still signed. Its asset just stays "Unknown asset".
- **The Chain Entry wins.** An asset the Chain Entry names is never stored.
- **Visibly not official.** Wherever it matters, a stored name says where it came from, with the asset's shortened id: "from its contract" (`signed`, `contract`), "named by <origin>" (`app`) or "your label" (`label`). That means the Assets screen, the Activity details sheet, and the approval window's outputs and amounts. Home's balance rows show only the ticker and name: there the mark would be noise beside every stored asset. The contract chose the name, and a label is only the user's: neither is this release's word.
- **Not encrypted,** like Grants: it's readable without the password, so a locked wallet still names its assets. It holds only what the chain or the user already made public.

## Apps suggest names (`suggestAsset`)

A Sidechain App with a Grant for `suggestAsset` can suggest an asset's name, by its contract or as a plain name, as Ethereum's `wallet_watchAsset` does. Everything that can refuse it runs before the window opens: the contract check, the ticker rule, and the rule that a contract's name is never replaced. So a site can't use the window to show the user a name the wallet would refuse anyway. The user then approves or rejects. A plain name stays the app's, never the user's: it's marked "named by <origin>", since nothing but that site backs it. Each origin can have one suggestion waiting at a time (-32002), and it needs no key, so no unlock. The window shows the wallet's balance of the asset in the suggested units, so the user sees what approving would show. That balance is read only if the wallet is already unlocked: a suggestion never asks for the password just to show it.

## Considered Options

- **A suggestion with no Grant (as `wallet_watchAsset`):** rejected. Any site could open windows; a Grant limits it to sites the user connected.
- **Store an approved plain name as the user's label:** rejected. The user only agreed to it; the name is the app's, and the mark should say whose.

- **Fetch names from a registry (Liquid's, or the server's `contract`):** rejected, as in ADR 0005. A name the wallet can't check could pass for another asset. Here the server only says which outpoint to check, and the wallet derives the rest.
- **Trust Esplora's `contract_hash`:** rejected. The id derivation checks the contract against the asset itself, so the server can't make one pass for another asset.
- **Check the contract in the TypeScript wallet:** rejected, as in ADR 0009. The derivation and the contract format are Elements', so they belong in its Chain Module, behind a capability another chain's module can leave out.
- **Put stored assets in the Chain Entry's list:** rejected. The Chain Entry is what ships with the release, and the marks depend on telling the two apart.
- **Encrypt it with the Vault:** rejected. Nothing in it is secret, and naming assets while locked needs it readable.
- **Keep the contract's JSON for `signed` too:** not done. The wallet base doesn't read `evidence` (ADR 0009), and the Clear View carries the checked fields, not the bytes.

## Consequences

- `elements.wasm` declares `assetContract`, and refuses a contract that doesn't check out with `invalidContract`. The L1 module doesn't declare it.
- `assets.addByContract` works only over Esplora. A Standard Sidechain API server doesn't report an issuance's outpoint yet.
- The Assets screen (`#/assets`, #51) adds, renames and removes them. Reissuance is #48.
- A label can rename an earlier label or an app's name, but never replaces a name from the asset's contract: the user removes that first. An app's plain name can't replace one either. Nothing replaces the Chain Entry's names.
