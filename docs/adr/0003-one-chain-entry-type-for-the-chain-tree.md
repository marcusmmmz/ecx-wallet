# One Chain Entry type for every chain of the tree; the identity check is a block at a height

The L1 account (#30) needs what a Slot already has: a network description compiled into its module, a server named as `{ api, url }` (ADR 0002), an identity check, and a user override (spec #12). eCash itself has no Slot, though, and the idea of drivechains of drivechains has come up. So the chains form a tree, and a Chain Entry describes one node of it:

```json
{
  "name": "Elements",
  "slot": 24,
  "networks": {
    "betanet": {
      "chain": "ecash:betanet-s24",
      "parent": "ecash:betanet",
      "identityBlock": { "height": 0, "hash": "a7754c…" },
      "sidechainServer": { "api": "esplora", "url": "https://explorer.bitnames.info/api" },
      "officialApps": [],
      "params": { "genesisHash": "a7754c…", "policyAsset": "…", "addressParams": { … }, … }
    }
  }
}
```

- **The root is the entry with no parent.** `slot` and `parent` are both present or both absent, and each network has exactly one root (eCash, `core/l1/chain-entry.json`). A Slot is a chain's number under its parent, as in BIP300.
- **`params` belong to the module.** Only the module reads them. The envelope (`chain`, `parent`, `identityBlock`, `sidechainServer`, `officialApps`) is the same for every chain, and the wallet reads only the envelope. Elements' `parentGenesisHash` stays in `params`: it's an Elements peg parameter, not a pointer to the parent.
- **Identity is a block at a height.** An Esplora server is on the chain if `/block-height/H` returns the expected hash (this replaces ADR 0002's `/block-height/0`). H is 0 for a chain with its own genesis. A fork, whose genesis is its ancestor's, uses the first block after the fork. eCash betanet's genesis is Bitcoin's, so its identity block is the fork block, `{ 967680, 00000000000000030101ba5c…d9d04042 }`: Bitcoin servers fail the check, and so do ECX mainnet servers (mainnet forks later, at 973,728). The node's chainparams carry only the fork height, so the hash was read from two betanet explorers (2026-10-20) and is pinned in the entry.
- **Keys follow the tree position.** The root's module gets the L1 Account Key (`m/84'/0'/0'`). A child of the root gets its Slot's Starter. The wallet routes keys from the entry and fails loudly for anything deeper.

Cross-entry rules are checked by the wallet's tests: every `parent` names a root `chain`, and Elements' `parentAddressParams` equals its parent's `addressParams`. That field is a copy, because `elements.wasm` must be self-contained.

## Considered Options

- **A separate "Mainchain Entry" type for L1:** rejected. It would need a second dispatch path for servers, the override and the identity check, and it doesn't extend to nested chains.
- **A reserved Slot (0) for L1:** rejected. Slot 0 is a valid BIP300 Slot, and L1 has no parent to number it under.
- **Keep `genesisHash` as the identity and special-case forks:** rejected. The same check now works for both, and Elements spells out `{ 0, <genesis> }`.
- **Replace `parentGenesisHash` with `parent`:** rejected. The two mean different things (see above).

## Consequences

- Elements' genesis appears twice (in `identityBlock` and in `params`), and a test keeps the two equal.
- **Open if nested drivechains appear:** Starters are `m/44'/0'/<slot>'` from the Master Mnemonic, keyed by the Slot alone. Slot 3 under eCash and Slot 3 under Slot 24 would get the same Starter, which breaks the one-Starter-per-chain isolation (#7). A non-root, non-child chain needs a derivation of its own, still BitWindow-compatible for the children of the root. The CAIP-2 IDs would also nest (`ecash:betanet-s24-s3`).
- The mainnet network (#32) needs its own fork-block hash once mainnet exists. **Amended 2026-11-12:** done in ADR 0019.
