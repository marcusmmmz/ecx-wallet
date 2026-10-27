# Flush spends carry no replay marker

`flush.wasm` (Flush, #56) is a copy of `l1.wasm`'s PSBT rules: every input carries its whole previous transaction, which must hash to the txid it names, and `sign` signs only P2WPKH inputs that re-derive. It leaves out one rule. L1 refuses a spend whose `nLockTime` isn't `replayLockTime` or that has a final `nSequence` (ADR 0004); Flush has no such check, and its Send uses `nLockTime` 0.

ADR 0004's reason is that eCash shares Bitcoin's keys, addresses and pre-fork coins, so an unmarked eCash spend is also valid on Bitcoin. Flush shares no coins with any chain. Its genesis is its own (`7d66b10e…` on betanet), it creates no coins of its own, and every coin it has comes from a Deposit paid out in one of its own blocks. A Flush transaction spends outputs that exist only on Flush, so no other chain can accept it. The keys are shared, since the Starter's `m/84'/1'/0'` keys also serve Slot 24, but a signature commits to the outputs it spends, not only to the key.

A marker would also have a cost. Flush Core reads `nLockTime` as Bitcoin does, and its own wallet sets it to about the tip's height (`DiscourageFeeSniping`, `src/wallet/spend.cpp` at backbone-flush `48e822b`). An app that builds the same way would have every request refused by a rule only this wallet enforces.

## Considered Options

- **Keep L1's check, with a Flush value in its Chain Entry:** rejected. It protects nothing, and it refuses transactions built the way Flush Core builds them.
- **Share one PSBT module between `core/l1` and `core/flush`, with the marker as a flag:** rejected for now. The two differ in the key they take (the L1 Account Key or a Starter), in Treasuries and Deposits (L1 only), in Flush's operation tags, and in this rule. A flag that turns off a safety check is the kind of switch a later change flips by mistake. The copy is about 100 lines; revisit if a third Bitcoin-like chain arrives.

## Consequences

- An L1 rule now has one exception, recorded here. A future sidechain that shares coins with another chain (a fork, as eCash is of Bitcoin) needs its own marker, and this ADR doesn't apply to it.
- Flush follows ADR 0007 as Elements does, not L1: an input or output paying the receive address apps are given is the wallet's without `bip32_derivation`, and a request with no input of the wallet's is refused (`nothingToSign`).
