# core

The Rust signing core. A Cargo workspace (not a Rust crate per se; `package.json` only wires it into
pnpm):

| Crate | What it is |
|---|---|
| `vault/` (`ecx-vault`) | The Vault: BIP39 create (from caller entropy) and import checks, Argon2id password stretching, Starter derivation (BitWindow's `DeriveStarter`), and the L1 Account Key (`[fp/84h/0h/0h]xprv…`, BIP84 account 0). Pure Rust, no I/O, no RNG. Seam 2 tests in `vault/tests/`. |
| `chain-entry/` (`ecx-chain-entry`) | The Chain Entry's shared envelope (docs/adr/0003), generic over each module's own `params`: `slot`/`parent` (both or neither; the root, eCash, has neither), `identityBlock`, `sidechainServer`, `officialApps`. |
| `abi/` (`ecx-wasm-abi`) | The C ABI every module's `.wasm` exports: `alloc`/`dealloc`, a result buffer (`out_ptr`/`out_len`/`out_clear`), status 0 = ok, 1 = UTF-8 error. |
| `vault-wasm/` (`ecx-vault-wasm`) | Thin `extern "C"` wrappers: ships as `vault.wasm`. |
| `elements/` (`ecx-elements`) | The Elements Chain Module (Slot 24, explicit-only): `declare()`, `derive_account(starter, receive, change)` (LWK `elwpkh` at `m/84'/1'/0'`, receive `/0/i` and change `/1/i` addresses in `elements1…`, each with its compressed public key), `decode(payload, starter, evidence)` (refusals for genesis / confidential / missing input fields / nothing to sign / evidence that doesn't check out, e.g. an `assetContract` not matching its committed hash, docs/adr/0009; then a Clear View: inputs (with a new issuance's asset and token ids, derived from the outpoint and contract hash; a reissuance is Blind, docs/adr/0008), outputs with destination and yours/not-yours by re-deriving, fee, dangerous modes (non-default sighash, withdrawal burn), when the hand-written Decoder in `clear.rs` understands every field, else `Blind { reason, verifiableFacts }`) `deposit_destination(starter)` (the `depositDestination` capability: the first receive address as UTF-8 bytes for an M5, the pegged asset, minimum 3,000 sats), `sign(payload, starter)` (only inputs whose path is `m/84'/1'/0'/{0,1}/i`, re-derives to the listed key and whose script is that key's p2wpkh: LWK's `SwSigner` checks none of that, so `ownership.rs` does before LWK sees the input; an input with no `bip32_derivation` only if it spends the receive address `getAddresses` gives out, docs/adr/0007), `asset_contract(asset, txid, vout, contract)` (the `assetContract` capability, no Starter: the contract, if the asset id derives from that outpoint and the SHA-256 of its exact bytes and it passes the registry rules; else `invalidContract`, docs/adr/0010), `build_transfer(order, starter)` (the `buildTransfer` capability: an unsigned PSET from the given explicit coins to one or more outputs, largest first per asset, change per asset, the fee in the policy asset, Elements Core's dust rule; refuses confidential destinations; docs/adr/0006) and `finalize(payload)` (raw tx hex). Bundles Slot 24's Chain Entry, `elements/chain-entry.json` (or `$ECX_ELEMENTS_CHAIN_ENTRY`, for the e2e build; see `elements/build.rs`): the one home of every betanet value (the envelope: parent `ecash:betanet`, identity block = genesis, the pinned `activation` (docs/adr/0004), `depositConfirmations` (6), the Sidechain Server as `{ api, url }` (docs/adr/0002) and Official App placeholders; and `params`: genesis, policy asset, address params, and a copy of the parent chain's L1 address params, from `CMainParams` in github.com/ecash-com/bitcoin `src/kernel/chainparams.cpp`: `bech32_hrp` "bc", P2PKH prefix 0, P2SH prefix 5). Seam 2 tests in `elements/tests/`. |
| `elements-wasm/` (`ecx-elements-wasm`) | Thin `extern "C"` wrappers returning JSON: ships as `elements.wasm` (`declare`, `chain_entry`, `derive_account`, `deposit_destination`, `check`, `decode`, `sign`, `build_transfer`, `finalize`; a refusal is the error result as JSON `{ code, message }`). |
| `l1/` (`ecx-l1`) | The L1 (eCash) Chain Module, the root of the tree: `declare()`, `derive_account(l1_account_key, receive, change)` (BIP84 `wpkh` at `m/84'/0'/0'`, `bc1q…` from the Chain Entry's HRP; refuses anything but an L1 Account Key), `treasury_script(slot)`, `build_deposit(order, key)` (an unsigned M5 PSBT from the given coins: largest first, fee and change in the module, every input with its whole previous transaction), `check(payload)`, `decode(payload, key)` (the L1 Decoder: address outputs and Deposits, else Blind), `sign(payload, key)` and `finalize(payload)` (raw tx hex). All four PSBT entry points refuse a spend without the replay marker (docs/adr/0004). Bundles eCash's Chain Entry, `l1/chain-entry.json` (or `$ECX_L1_CHAIN_ENTRY`): betanet's identity block is its fork block, 967,680, its `replayLockTime` 499999999 and its `opDrivechain` NOP8 (sources in `l1/src/chain_entry.rs`). Seam 2 tests against BIP84's vectors and of Deposits in `l1/tests/`. |
| `l1-wasm/` (`ecx-l1-wasm`) | Thin `extern "C"` wrappers returning JSON: ships as `l1.wasm` (`declare`, `chain_entry`, `derive_account`, `treasury_script`, `build_deposit`, `check`, `decode`, `sign`, `finalize`; a refusal is the error result as JSON `{ code, message }`). |
| `flush/` (`ecx-flush`) | The Flush Chain Module (Slot 46, provisional): `declare()`, `derive_account(starter, receive, change)` (BIP39 seed of the Starter, no passphrase, BIP84 `wpkh` at `m/84'/1'/0'` as Flush Core's own wallet off mainnet, `bflx1…` from the Chain Entry's HRP), `build_transfer(order, starter)` (the `buildTransfer` capability: an unsigned PSBT paying ECX from the given coins, each with its whole transaction; largest first, never a value-0 coin (a token's), change unless dust (294 sat for P2WPKH), Flush Core's dust and relay rules), `check(payload)`, `decode(payload, starter)` (the Flush Decoder: plain ECX payments, else Blind, naming the Flush operation an `OP_RETURN` tag marks), `sign(payload, starter)` and `finalize(payload)`. L1's PSBT rules without the replay marker (docs/adr/0011); ADR 0007's given-out address and `nothingToSign` as Elements. Bundles Slot 46's Chain Entry, `flush/chain-entry.json` (or `$ECX_FLUSH_CHAIN_ENTRY`; sources in `flush/src/chain_entry.rs`). Seam 2 tests in `flush/tests/`. Follows backbone-flush `flush-betanet` for betanet (Slot 99) and `main` for mainnet (Slot 46). |
| `flush-wasm/` (`ecx-flush-wasm`) | Thin `extern "C"` wrappers returning JSON: ships as `flush.wasm` (`declare`, `chain_entry`, `derive_account`, `build_transfer`, `check`, `decode`, `sign`, `finalize`; a refusal is the error result as JSON `{ code, message }`). |
| `vendor/lwk_common/` | crates.io `lwk_common` 0.19.0 with one line changed (getrandom `js` → `custom`; marked `ECX PATCH`), wired in by `[patch.crates-io]`. |

No wasm-bindgen: each `.wasm` imports **nothing** (it exports its own memory). The TypeScript side is
hand-written: `wallet/src/wasm.ts` (generic ABI glue, `CoreModule`) and one typed wrapper per kind
of module (`wallet/src/vault-module.ts`, `wallet/src/chain-module.ts` for every Chain Module). Randomness always comes in as bytes from the host.

## Build and test

```sh
pnpm --filter @ecx/core build   # core/dist/*.wasm (the root `pnpm build` runs this first)
pnpm --filter @ecx/core test    # cargo test --locked --workspace (the root `pnpm test` runs it)
```

Needs rustup (picks up `rust-toolchain.toml`: Rust 1.98.0 + `wasm32-unknown-unknown`), and a clang
with the WebAssembly backend plus `llvm-ar` for libsecp256k1 (override with
`CC_wasm32_unknown_unknown` / `AR_wasm32_unknown_unknown`; on macOS use Homebrew LLVM). wasm-opt
comes pinned from npm (`binaryen`).

`scripts/build.mjs` builds with `--locked`, remaps build-machine paths out of the binaries, runs
`wasm-opt -Oz` (with the `--enable-*` feature flags rustc's output needs) and fails unless each
module imports nothing but memory (`scripts/check-wasm-imports.mjs`). It prints each module's
sha256. Dependencies are pinned exactly; libsecp256k1 uses its `lowmemory` tables.

## Adding a module (e.g. the Elements Chain Module)

1. A pure crate with its logic and native tests, plus a `<name>-wasm` cdylib crate that depends on
   it and on `ecx-wasm-abi` (re-export the ABI functions as `vault-wasm` does) and exposes
   `#[no_mangle] extern "C"` functions taking `(ptr, len)` pairs / `u32`s and returning
   `ecx_wasm_abi::ret(...)`.
2. Add both to the workspace and one line to `MODULES` in `scripts/build.mjs`.
3. A typed wrapper in `wallet/src/` over `CoreModule` (see `vault-module.ts`); the background
   fetches the `.wasm` lazily via `chrome.runtime.getURL` (see `loadVault` in
   `extension/src/background.ts`). The extension build stages every `core/dist/*.wasm` itself.
   A Chain Module also gets a line in `CHAIN_MODULE_FILES` (`wallet/src/accounts.ts`) and
   implements the `declare` / `chain_entry` / `derive_account` exports `chain-module.ts` expects.
4. If it pulls in LWK: depend on the already-vendored `lwk_common` (see above) and register a
   failing getrandom backend, as `elements/src/lib.rs` does.
