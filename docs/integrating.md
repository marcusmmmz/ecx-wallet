# Integrating a Sidechain App with ECX Wallet

For developers of a site that wants its users to pay, trade or sign with ECX Wallet. The methods, Grants and error codes are in [The Provider](how-it-works.md#the-provider); this page covers how your site finds the wallet and what it must allow.

## Where your users' wallet can be

| Where | How your site reaches it | What it needs from you |
|---|---|---|
| **The browser extension** | It announces a Provider on every page. | Nothing. |
| **A web wallet that opened your site** (ECX Wallet's Apps view, or any other web wallet that speaks the [web wallet protocol](web-wallet-protocol.md)) | Your page is in its frame and talks to `window.parent`. | Allow framing (below). Requests need no click. |
| **The web wallet in a popup** (no extension, site opened directly) | Your site opens the web wallet's `#/provider` page. | The first request must come from a click, or the browser blocks the popup (4900). |

All three answer the same `request({ method, params })` calls and `grantChanged` event.

## Finding the wallet

### With `client`

`client.js` handles all three. A web wallet built from this repo serves it, bundled, at `/client.js`; import it from there, or host your own copy:

```js
import { discoverProviders } from "<web wallet URL>/client.js";

// A framing wallet first, then extensions, else the web wallet at `webWallet` in a popup.
const [wallet] = await discoverProviders({ webWallet: "<web wallet URL>" });
```

`wallet.info.name` says which one it is: the extension's name, `Wallet at <origin>` for a wallet framing your page, or `ECX Wallet (web)` for the popup. Loading it from the wallet's site needs that origin in your `script-src`. The file changes with each deploy, so don't pin it with SRI.

### Without `client`

Nothing to load. Each case is a few lines.

**The extension** answers an event, as EIP-6963 does for Ethereum wallets:

```js
function extensionWallets(timeoutMs = 200) {
  const found = new Map();
  const onAnnounce = (event) => found.set(event.detail.info.uuid, event.detail);
  window.addEventListener("ecx:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("ecx:requestProvider"));
  return new Promise((resolve) => setTimeout(() => {
    window.removeEventListener("ecx:announceProvider", onAnnounce);
    resolve([...found.values()]); // each { info: { uuid, name, icon, rdns }, provider }
  }, timeoutMs));
}
```

**A web wallet framing your page:** paste `framingWallet()` from [the protocol doc](web-wallet-protocol.md#the-app-side-framed-without-client). It resolves to a provider, or `null` when no wallet frames the page.

**The popup** needs more (opening the window, waiting for it, noticing it close): use `client` for it, or follow the [protocol doc](web-wallet-protocol.md).

## Letting web wallets open your site

A web wallet can only show your site if your site lets it be framed. Send:

```http
Content-Security-Policy: frame-ancestors *
```

`*` lets any web wallet open your site. It also lets any other site frame it, which matters only if one click on your site can act on a logged-in session (clickjacking). Approvals happen in the wallet, not on your page. To allow only some wallets, name their origins: `frame-ancestors https://wallet.example`. Don't send `X-Frame-Options: DENY` or `SAMEORIGIN`.

Inside a wallet's frame, your site is third-party:

- **Storage** (localStorage, IndexedDB) is separate from your own tab. What a user saved on your site directly isn't there.
- **Cookies** need `SameSite=None; Secure; Partitioned`. Brave, Firefox and Safari block or partition the rest. Connecting to the wallet uses no cookies.
- Your page can't navigate the wallet's tab. In ECX Wallet, links you open in a new tab open normally.

## A typical flow

```js
// On load: no window opens, and it works while the wallet is locked.
const grant = await wallet.provider.request({ method: "getGrant" });

// From a click: ask for a Grant (the user approves in the wallet), then for an address.
await wallet.provider.request({ method: "connect", params: { slots: [46], methods: ["getAddresses", "sendTransfer"] } });
const [{ address }] = await wallet.provider.request({ method: "getAddresses", params: { slot: 46 } });

// Revoked on the wallet's Grants screen, or by `disconnect`: back to "Connect".
wallet.provider.on("grantChanged", (scope) => { if (scope === null) showConnect(); });
```

A request the user turns down fails with `code` 4001; show it as a choice, not an error. Slots: Flush is 46 on mainnet (99 on betanet). The other methods (`sendTransfer`, `sendAction`, `signTransaction`, `suggestAsset`) and every error code are in [The Provider](how-it-works.md#the-provider).

**Flush DEX sites** that use the extension's `window.flush` (`flush_requestAddress`, `flush_submit({ uri })`) get no `window.flush` inside a web wallet. There, call `getAddresses({ slot: 46 })` and `sendAction({ slot: 46, action: uri })`, with a Grant for `getAddresses` and `sendTransfer`: `connect({ slots: [46], methods: ["getAddresses", "sendTransfer"] })`. A `sendTransfer` Grant also covers `sendAction`, which has no Grant of its own; asking for one fails with 4200 (see [ADR 0016](adr/0016-flush-actions-through-window-flush.md)).

## Trying it

`pnpm demo` serves a demo app at `http://localhost:5180/` that does all of the above. To try framing against a wallet built from this repo, serve the web build (`pnpm build:web`, then `app/build-web` with its `_headers`) on another origin, such as `http://127.0.0.1:5300`. Open its Apps view, and enter `localhost:5180/?wallet=http://127.0.0.1:5300/`. The web wallet frames pages on `localhost` too, so you can try your own site from your machine.
