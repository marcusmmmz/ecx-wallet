# A new issuance gets a Clear View; a reissuance stays Blind

An app's issuance PSET (#45) was always Blind: the Decoder didn't explain an input's issuance fields, so the user saw "input 0 issues or reissues an asset" and had to trust the site. The Decoder now explains a **new** issuance, and the request is Clear. That also means the Grant no longer needs the Blind Signing opt-in for it.

- **The wallet derives the ids itself.** The new asset's id and its reissuance token's id come from the input's outpoint and the contract hash (`issuance_asset_entropy`), as consensus derives them. Nothing the requester states about them is used.
- **What the user sees:**
  - a "Creates a new asset" section: the amount issued and the new asset's id;
  - the token's amount and id, if any;
  - the contract hash, or "No contract".
  
  Outputs paying either asset are labelled "New asset" or "Reissuance token", not "Unknown asset".
- **Base units.** The asset's precision is in its contract, and the wallet doesn't see the contract, so amounts are shown in base units and labelled that way. The name and ticker can still come from the requester's hints, shown as "Reported by".
- **Not a dangerous mode.** Issuing costs only the fee and moves none of the user's existing funds, so it is a plain section, not a red warning.
- **A reissuance stays Blind.** A non-null `issuance_blinding_nonce` makes the input a reissuance. Consensus requires the spent token's asset commitment to equal the token id blinded with that nonce, byte for byte ([`VerifyAmounts`, confidential_validation.cpp:241-259](https://github.com/ElementsProject/elements/blob/3c40bb994720616841715448cb9957ada984c556/src/confidential_validation.cpp#L241-L259), upstream master `3c40bb99`; the Elements+ fork wasn't checked). This wallet's tokens are explicit (rule 6), and an explicit asset never matches. So a reissuance this wallet signs could never be valid, and the Decoder doesn't explain one. Making tokens reissuable is #48.

## Considered Options

- **Show the contract (name, ticker, precision), checked against the committed hash:** a separate decision, made in ADR 0009. The Signing Request carries the contract's exact JSON as `evidence`, and the module hashes those bytes and compares them with the committed hash, so it needs no canonicalisation.
- **Explain reissuance too:** rejected for now. The Decoder would need to prove that the spent input is the token for the stated entropy, for a transaction that can't be valid while tokens are explicit.
- **Mark issuance as a dangerous mode:** rejected. A red warning should mean the user could lose funds or control, and issuing does neither.

## Consequences

- The DEX's issuance page works with a Grant that doesn't opt into Blind Signing.
- The approval says that the token can't issue more, since every token this wallet creates is explicit. Apps are told to issue with `issuance_inflation_keys = 0` until #48 lands.
