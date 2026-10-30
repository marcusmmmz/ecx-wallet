# The build picks the network, and a chain's Slot is per network

Takes up the option ADR 0014 deferred to mainnet (#32). ECX mainnet forked at height 973,728 on 2026-10-29. Flush is Slot 99 on betanet and Slot 46 on mainnet, and Elements+ (Slot 24) has no mainnet chain.

- **`slot` moves into each network** of the Chain Entry, next to `parent`: `networks.<name>.slot`. On each network the root has neither, and every other chain has both. `check` also refuses a `chain` that doesn't end in `-s<slot>`, so a Slot 99 network can't be labelled as Slot 46.
- **The build picks one network:** `$ECX_NETWORK`, read by each module's `build.rs` into `NETWORK` and by `core/scripts/chains.mjs` for the JS builds. The shipped extension and web builds are **mainnet**. The e2e build and its tests are **betanet**, which every fixture is of. `cargo test` defaults to betanet for the same reason.
- **A build bundles only the modules whose Chain Entry names its network.** The mainnet build ships `l1.wasm` and `flush.wasm`, without `elements.wasm`. The build writes `wallet/src/module-files.ts` (Slot to `.wasm`) for its network, and takes `host_permissions` and the CSP's `connect-src` from that network's servers only.

The mainnet entries (sources read 2026-10-30):

- **eCash, `ecash:mainnet`:** the identity block is the fork block, 973,728, `0000000000000001441a…6dc146ed`. explorer.ecash.ninja and explorer.blockfab.org agree on it. Bitcoin's 973,728 (`…ab2e2c11`) and betanet's (`…209f4f2e`) differ, and its 973,727 is Bitcoin's. The node's `mainnet-bridge` branch (`ecash-com/bitcoin` `9ac3e37`) sets `EcashHeight` 973728 (its `EcashForkBits` match the block's), address prefixes 0/5/`bc`, and the replay marker `LOCKTIME_THRESHOLD - 2` = **499999998**. The enforcer (`bip300301_enforcer` `9c82499`, PR #666) reads `OP_DRIVECHAIN` as NOP8 on eCash. Server: `explorer.ecash.ninja/api`, the operator of betanet's, with CORS `*`.
- **Flush, `ecash:mainnet-s46`:** Slot 46, address HRP `flx`, as backbone-flush `flush-betanet` (`ed15158`) sets for `ChainType::ECASH`. The identity block is the genesis its explorer serves, `19b25cff…`. Coin type stays 1: Flush Core derives at 0' only on `ChainType::MAIN`, which an eCash sidechain is not. Server: `explorer.blockfab.org/flush/api`, with CORS `*` and a passing preflight for `POST`.
- **No `activation` for Flush on mainnet.** The M1 for Slot 46 is in block 974,164, and its M2 ACKs came in two runs: 974,165–975,346 and 977,020–978,331. On eCash mainnet the enforcer activates an unused Slot only with more than 1,815 ACKs within 2,016 blocks of its M1 (`Thresholds::ECX_MAINNET`), and neither run has as many. Flush's mainnet node pins no activation height (`main_activation_height = 0`) and credited a 1.5 ECX Deposit made in block 978,603. So the wallet sends and receives on Flush mainnet but makes no Deposit to it (ADR 0004) until an activation is found and pinned.

## Considered options

- **Mainnet only, betanet dropped:** rejected. Elements+ is mainnet-less, and the e2e suite (stub servers, betanet fixtures) exercises it in most files. Dropping betanet would drop that feature and its tests.
- **A network switch inside the app:** rejected for now. It would bundle every module twice and keep each network's accounts, Deposits and grants apart. The build-time switch costs one variable.
- **Two Chain Entry files per module, one per network:** rejected. The modules already pick a network from one entry. Moving `slot` keeps that, and keeps a chain's networks side by side.
- **Pin the block where the second ACK run ends (978,331) as Flush's activation:** rejected. By the enforcer's rule the Slot isn't active, and a Deposit to a Slot that never activates can't be withdrawn.

## Consequences

- Chain Entries with a top-level `slot` no longer parse (`deny_unknown_fields`).
- Each build serves one network. A betanet install updated to the mainnet build keeps its Vault (the same keys on both networks). What it stored per Slot or per chain for betanet (Slot 24's and 99's Deposits and grants, `assets:ecash:betanet-s99`) stays in storage unused.
- The shipped build and the e2e build differ in their network, not only in their servers. `build-output.test` checks that the pages and manifest are the same, that the background differs only in its module map, and that each module's Chain Entry differs only in betanet's server.
- The betanet build's tests don't run the mainnet modules' code paths. The mainnet entries are pinned by the Rust tests, and the shipped modules' bindings by `core-modules.test`.
- Pinning Flush's mainnet activation, or Elements+ getting a mainnet chain, is an edit to its Chain Entry. The build picks it up.
