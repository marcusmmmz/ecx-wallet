# Every L1 spend is replay-marked, and a first Deposit needs a pinned activation

Deposit (#31) is the wallet's first L1 spend: an M5 that `l1.wasm` builds from the account's own coins and signs. Two rules come with it.

## The replay marker is an invariant of `l1.wasm`

eCash shares Bitcoin's keys, addresses and pre-fork coins, so a plain spend on eCash is also valid on Bitcoin. ECX's replay protection is a marker: `nLockTime` set to the network's magic value, with a non-final `nSequence` on every input. betanet's value is 499999999 (`LOCKTIME_THRESHOLD - 1`), which only betanet treats as final; mainnet's will be 499999998 (#32). Both are `replayLockTime` in eCash's Chain Entry, next to `opDrivechain` (NOP8), as L1 params only `l1.wasm` reads.

- `build_deposit` always sets the marker: `nLockTime = replayLockTime` and `nSequence = 0xfffffffd` (non-final, replaceable) on every input, the Treasury's included.
- `check`, `decode`, `sign` and `finalize` all refuse (`noReplayMarker`) a PSBT whose `nLockTime` isn't `replayLockTime` or that has an input with a final `nSequence`. So the module never signs an unmarked spend, whoever built it.
- There's no pre-fork refusal. A marked spend of a pre-fork coin is itself the coin split: once it confirms, the coin is gone from eCash's UTXO set, and the transaction is invalid on Bitcoin.

The module also only signs what it can vouch for. Every input carries its whole previous transaction (`non_witness_utxo`), which must hash to the txid the input names. So the values the Decoder shows, the fee among them, and the Treasury's current value come from data the server can't alter.

## A first Deposit needs the Slot's activation pinned

The wallet finds a Slot's Treasury on its own L1 Esplora by #15's strict exactly-one rule (`wallet/src/treasury.ts`). A Slot that has never had a Deposit has no Treasury, and its first M5 spends none (the enforcer's `create_deposit_psbt`). Over Esplora, "active, no Deposit yet" looks the same as "not active". An M5 to an inactive Slot pays an anyone-can-spend output, and the funds are lost. Slot 24 on betanet is in that state: active since block 970,715 (1,009 consecutive M2 ACKs), never funded.

So a Slot's Chain Entry may pin `activation: { height, hash }` per network: the parent-chain block whose M2 activated it. It's part of the envelope (ADR 0003), only for a chain with a parent, because the wallet reads it, not the module. Then:

- **One Treasury:** the M5 spends it. The pin plays no part.
- **No Treasury, with a pin:** the wallet checks the L1 server has the activation block at its height (`/block-height/H`), then builds an M5 that spends no Treasury. The Decoder flags it (`firstDeposit`), and the approval window warns: the wallet can't confirm the Slot is active and still empty, the funds can be lost if either is wrong, and a racing first Deposit is refused or dropped, its coins coming back. (This said "can leave coins stuck in mempools" until #57's research: Backbone checks an M5 against the Treasury as its mempool leaves it, refuses a second first Deposit with `bad-dc-escrow-unspent`, and drops the losing one once a block confirms the other.)
- **No Treasury without a pin, or several Treasuries:** a refusal, with no approval window.

A pin is the only guard against an inactive Slot: Backbone relays and mines an M5 to one, whose Treasury-shaped output is anyone's (#57). Flush's module declares `depositDestination` only once its Chain Entry pins an activation, so not even a Treasury someone else made at an inactive Slot draws a Deposit. Betanet's Flush, Slot 99, is pinned at block 968,998 (ADR 0014), and mainnet's, Slot 46, at 978,331 (ADR 0019).

A pin is a checked fact, added once someone has verified it. Slot 24's was read from esplora.beta on 2026-10-20; the enforcer may count the Slot as active from the next block (970,716), to confirm with the Elements developer before release.

## Esplora endpoints

Deposit adds these to ADR 0002's table. Both electrs forks serve them.

| Endpoint | Use |
|---|---|
| `GET /scripthash/:h/utxo` | The Treasury's candidates. `h` is the SHA-256 of the Treasury script in plain byte order, not Electrum's reversed order. |
| `GET /tx/:txid` | Whether a candidate's transaction is M5- or M6-shaped, and which Treasury a pending M5 spends (`vin[].prevout`). |
| `GET /tx/:txid/hex` | The previous transactions the PSBT carries. |
| `GET /address/:a` | `tx_count`: the first unused change address. |
| `GET /tx/:txid/status`, `GET /blocks/tip/height` | A Deposit's confirmations. |

## Considered Options

- **Refuse pre-fork coins until a coin-split flow exists:** rejected. The marked spend is the split.
- **Make the marker a building convention only:** rejected. `sign` is the one place every L1 signature goes through, so the invariant holds there for any future L1 builder.
- **Allow a first Deposit with only a warning, no pin:** rejected. The wallet would be guessing that the Slot is active, and getting it wrong loses the funds.
- **Put `activation` in Elements' `params`:** rejected. It's a fact about any Slot, and the wallet, not the module, acts on it.

## Consequences

- An L1 app that needs another `nLockTime` (a timelock) can't sign through `l1.wasm` in v0. Such a spend has no replay protection under this scheme anyway; revisit when one is needed.
- Every Slot that is active but has no Treasury needs its activation checked and pinned before the wallet deposits to it.
- Mainnet (#32) needs its own `replayLockTime` and, per Slot, its own activation.
