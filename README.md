# ECX Wallet

A browser wallet for eCash (ECX) and its drivechains (sidechains). One extension holds your keys for eCash, the main chain, and for each sidechain you turn on. It shows your balances and history, sends, deposits coins from eCash into a sidechain, and signs for sidechain websites after you approve.

**Status:** pre-release. The shipped build is for eCash **mainnet**, with one sidechain: Slot 46, Flush (ECX and its tokens; no Deposits to it until its Slot's activation is pinned, ADR 0019). A **betanet** build (`ECX_NETWORK=betanet pnpm build`) adds Slot 24, Elements+ (an Elements chain, explicit amounts only), and has Flush as Slot 99 (ADR 0014). The e2e suite runs on betanet.

Design work happens in GitHub issues; the [wayfinder map](https://github.com/marcusmmmz/ecx-wallet/issues/1) indexes every decision. The words used here (Slot, Starter, Chain Module, Grant, Clear Signing…) are defined in [GLOSSARY.md](GLOSSARY.md).

## Try it

```sh
pnpm install
pnpm build
```

Then in Brave (or any Chromium): `brave://extensions` → Developer mode → **Load unpacked** → `extension/dist/chromium`. On Firefox, load `extension/dist/firefox/manifest.json` from `about:debugging` → This Firefox → Load Temporary Add-on.

That build talks to the public mainnet explorers; `ECX_NETWORK=betanet pnpm build` builds for betanet's instead. To try it against local stub servers with a funded test wallet, see [Try the e2e build by hand](docs/testing.md#try-the-e2e-build-by-hand).

## Build and test

Needs node 22, pnpm, rustup (the toolchain is pinned in `core/rust-toolchain.toml`), clang with the WebAssembly backend and `llvm-ar` (see [core/README.md](core/README.md)), Brave at `/usr/bin/brave` (or `$BRAVE`) and Firefox at `/usr/bin/firefox` (or `$FIREFOX`).

```sh
pnpm test          # Rust tests, then build everything and run the e2e suite in headless Brave and Firefox
pnpm build         # build only: core/dist/*.wasm, then extension/dist/{chromium,firefox}
pnpm build:web     # core WASM, then the standalone web wallet in app/build-web
pnpm typecheck
```

- One browser only: `E2E_BROWSERS=brave pnpm test`. Watch the browser: `HEADFUL=1`.
- How the tests work and how to write one: [docs/testing.md](docs/testing.md).

## Web wallet

`pnpm build:web` writes a static site to `app/build-web` (or `pnpm --filter @ecx/app build:web` after building core). Serve it over HTTPS. It supplies the CSP and security headers twice: `_headers` for Netlify / Cloudflare Pages, and `vercel.json` for Vercel (`vercel deploy app/build-web`). A Vercel Git build uses the root `vercel.json` (it installs clang and llvm, then runs `pnpm build:web`), and the postbuild hands Vercel the site as Build Output with the same headers. Other hosts must send those headers themselves.

The web wallet supports eCash and Flush, with keys held in a dedicated Worker and encrypted data in IndexedDB. Reloading locks it: the session lives only in memory. Auto-lock uses a timer and checks the deadline when the tab becomes visible, as well as on every use. Approvals stay in the page. There is no Provider or dApp connection, and no browser side panel. Slot 24 is unavailable because its explorer sends no CORS headers (checked 2026-10-29).

## Release

Bump `version` in both `extension/manifests/*.json`, then push a matching tag (`git tag v0.0.2 && git push origin v0.0.2`). [`.github/workflows/release.yml`](.github/workflows/release.yml) builds and publishes a GitHub pre-release with one zip per browser and `SHA256SUMS`; its install steps come from [`.github/release-notes.md`](.github/release-notes.md). It doesn't run the tests: run `pnpm test` before tagging.

## Layout

A pnpm workspace:

| Directory | What's in it |
|---|---|
| `core/` | The signing core, in Rust: one `.wasm` per module (`vault.wasm` for keys, `l1.wasm` for eCash, `elements.wasm` for Slot 24, `flush.wasm` for Flush). See [core/README.md](core/README.md). |
| `wallet/` | The wallet's logic, in TypeScript, independent of any browser: the Provider, Grants, the Vault, accounts, Sidechain Servers, Send, Deposit, history. |
| `app/` | The UI: one SvelteKit static app. Every screen is a hash route (`index.html#/send/24`, `#/approve/<id>`…). |
| `extension/` | The MV3 shells for Chromium and Firefox: the background script, the content script and the injected Provider. |
| `client/` | A small library a sidechain website uses to find the wallet's Provider (`discoverProviders()`). |
| `stub-server/` | Fake Sidechain Servers for tests: Esplora, and the Standard Sidechain API (its protocol draft is in [stub-server/README.md](stub-server/README.md)). |
| `e2e/` | The end-to-end tests and their harness. |

## How it fits together

A sidechain website (a Sidechain App) asks the wallet for something:

```text
website ──client──▶ Provider (inpage.ts) ──▶ content script ──▶ background ──▶ wallet's Provider handler
                                                                   │
                                     approval window (app, #/approve/<id>) ◀── asks the user
```

The background gets the website's origin from the browser, never from the website. Only the background ever decrypts keys. Each chain's Chain Module (a `.wasm`) gets only its own chain's key, per call.

The wallet reads each chain from that chain's **Sidechain Server**, named in its Chain Entry: today, Esplora explorers for eCash and Slot 24, and Flush's explorer, an Esplora with Flush's own additions, for Flush.

## Read more

- [docs/how-it-works.md](docs/how-it-works.md): each feature in more depth (Vault, accounts, servers, balances, history, Send, Deposit, the Provider).
- [docs/testing.md](docs/testing.md): the e2e build, the test harness, Firefox, build gates.
- [docs/adr/](docs/adr/): the architecture decisions and why.
- [GLOSSARY.md](GLOSSARY.md): the domain language.
