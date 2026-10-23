# Evidence: requester data the Chain Module checks before showing it

A Signing Request had two kinds of content: the payload, which is signed, and `hints`, which are shown as "Reported by <origin>" and never checked. Some useful data fits neither. An issuance commits to its contract only by hash, so the wallet showed base units and a hash. The DEX knows the contract, and its hash can be checked against the payload. Other data with the same shape will come: a preimage behind an OP_RETURN commitment, a swap's terms against its HTLC hash, a reissuance proving which token it spends (#48).

A Signing Request can now carry `evidence`:

```json
"evidence": { "assetContract": { "0": "<the exact contract JSON>" } }
```

- **An object keyed by kind.** Each kind's value is that kind's own object. The wallet base doesn't read it. It passes `evidence` as it is to the Slot's Chain Module, as `decode(payload, key, evidence)`.
- **The module checks every kind it knows against the payload**, whether the request turns out Clear or Blind. If one doesn't check out, the request is refused (`invalidEvidence`, -32602). Only a Clear View shows evidence, and it never makes a Blind request Clear.
- **Unknown kinds are ignored**, like unknown envelope fields, so an older module simply shows less. The envelope's version is unchanged: the field is optional and older wallets drop it.
- **Separate from `hints`.** `hints` keeps one rule: it never changes the outcome. Evidence can refuse a request, and it goes to the module, not the approval window.
- **`sign` doesn't take evidence.** Evidence only adds to what the user is shown, and `decode` always runs first.

## `assetContract`

`{ "<input index>": "<contract JSON>" }`, for an input that issues a new asset.

- **The exact bytes.** One SHA-256 of the string must equal the input's committed contract hash, its raw bytes as in `issuance_asset_entropy`. The usual display is that hash reversed, as Liquid shows it; Tether's contract on Liquid is the test vector. The module doesn't reformat the JSON, so a reformatted contract doesn't match. "Sorted keys, compact" is the issuer's convention, not something the module rebuilds.
- **The Liquid asset registry's rules**, as `lwk_wollet::Contract::validate`:
  - version 0, precision 0–8;
  - a name of 1–255 characters and a ticker of 3–24 letters, digits, dots or hyphens;
  - an `entity.domain` that is a domain name, and an `issuer_pubkey` that is a compressed key.
  
  One rule is stricter than the registry: the name must be printable ASCII, so a contract can't put line breaks or control characters into the approval window.
- **What the approval shows:**
  - the issued amount in the contract's ticker and precision ("0.01 EXA (Example Asset)"), with outputs paying the asset shown the same way;
  - "Claims the domain example.com (not checked by this wallet)": the registry proves a domain by fetching a file from it, and this wallet doesn't;
  - "Issuer key: yours" when `issuer_pubkey` is the key of the address `getAddresses` gives out, otherwise "not yours".
  
  It also says the issuer chose these fields: the contract is committed, which doesn't make it true.
- **A contract for an input that issues no new asset**, or for an input that doesn't exist, is refused.

## Considered Options

- **A field just for contracts (`contracts`):** rejected for a kind-keyed `evidence`, which takes later kinds without another envelope change.
- **A list of `{ kind, … }` entries:** rejected. An object can't hold the same kind twice, and it matches how `hints.outputLabels` is keyed.
- **Inside `hints`:** rejected. `hints` would no longer be "never affects the outcome", and its contents would go to two different places.
- **Check in the TypeScript wallet:** rejected. The contract format is Liquid's, specific to the Elements module, and everything in a Clear View comes from the module.
- **Show a contract that doesn't match, with a warning:** rejected. A mismatch means a buggy or lying requester, and refusing tells the requester at once.
- **Canonicalise the contract before hashing:** rejected. Hashing the bytes as sent is simpler, and a requester that formats it differently sees the refusal.

## Consequences

- The L1 module's `decode` takes evidence and ignores it: no L1 kind exists yet.
- Each new kind is decided per module, with its own check and its own refusal message.
