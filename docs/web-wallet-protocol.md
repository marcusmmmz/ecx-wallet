# Web wallet protocol (draft)

**Status: draft.** This may change while no outside app or wallet depends on it. If you implement it, tell us (issue #91) and we'll coordinate any change.

How a Sidechain App and a web wallet talk over `postMessage`, when no browser extension injects a Provider. `client` implements the app side (`client/src/framed.ts`, `client/src/web-wallet.ts`), and this wallet implements the wallet side (`serveFrame` and `serveOpener` in `app/src/lib/platform/web.ts`). An app can use `client` (bundled at `<wallet>/client.js`, or a copy it hosts itself) or implement this page directly. Any wallet on any origin can implement the wallet side.

## Two ways in

- **Framed:** the wallet opens the app in an `<iframe>`. The app talks to `window.parent`. The app must let the wallet frame it (`Content-Security-Policy: frame-ancestors <wallet origins>`, or `*` to work in any wallet). No click is needed.
- **Popup:** the app opens the wallet with `window.open` at `<wallet>#/provider`, from a click, and talks to that window. This needs the wallet's URL.

## Messages

Every message is a plain object with `channel: "ecx:webWallet"` and a `type`.

| `type` | From → to | Fields | Meaning |
|---|---|---|---|
| `hello` | either way | | "Are you there?" The wallet answers `ready`. A framed app answers the wallet's `hello` with its own. |
| `ready` | wallet → app | | The wallet listens. A popup that says it again has reloaded and dropped what it was answering. |
| `request` | app → wallet | `id` (string, unique), `method`, `params` | A Provider request, as `provider.request({ method, params })`. |
| `response` | wallet → app | `id`, `response`: `{ ok: true, result }` or `{ ok: false, error: { code, message } }` | The answer to the request with that `id`. Error codes are EIP-1193's (4001 rejected, 4100 unauthorized, 4200 unsupported, 4900 disconnected). |
| `event` | wallet → app | `event` (`"grantChanged"`), `payload` | A Provider event for this app's origin. |

The methods and events are the Provider's: see [The Provider](how-it-works.md#the-provider).

## Framed: the order of messages

1. On load, the app posts `hello` to `window.parent` with target origin `"*"`. It carries nothing.
2. The wallet answers `ready` to the origin the browser reported for that `hello`. The app then sends its requests to that origin only.
3. After each `load` of the frame, the wallet posts `hello` to the frame with target `"*"`, and the app answers `hello`. The frame can navigate itself to another site, which the wallet can't see, so this tells the wallet who is there now.

## Origins

Neither side trusts an origin written in a message. Each takes the other's from `event.origin`, and checks `event.source`:

- **The wallet** accepts messages only from the window it serves (the frame's `contentWindow`, or `window.opener`). It takes the app's origin from each message's `event.origin`, ignores `"null"` and its own origin, and replies to that origin only. A framing wallet shows the origin of the frame's latest message, and forgets it on each `load` of the frame.
- **The app** accepts messages only from `window.parent` (framed) or the window it opened (popup), and only from the wallet's origin: for a popup, the URL it opened; framed, the origin that answered its `hello` with `ready`.

## The app side, framed, without `client`

All an app needs to use the wallet framing it. Checked against this wallet in Brave and Firefox (2026-10-31).

```js
// The web wallet this page is open in, if any (protocol: docs/web-wallet-protocol.md in ECX Wallet).
// Resolves to a provider, or null when the page isn't framed by a wallet.
function framingWallet(timeoutMs = 1000) {
  if (window.parent === window) return Promise.resolve(null);
  const CHANNEL = "ecx:webWallet";
  const pending = new Map();
  const listeners = new Map();
  let origin = null;
  const provider = {
    /** The wallet's origin, as the browser reports it. */
    get origin() { return origin; },
    request({ method, params }) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ channel: CHANNEL, type: "request", id, method, params }, origin);
      });
    },
    on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); },
  };
  return new Promise((found) => {
    const timer = setTimeout(() => found(null), timeoutMs);
    window.addEventListener("message", (event) => {
      const m = event.data;
      if (event.source !== window.parent || m?.channel !== CHANNEL || event.origin === "null") return;
      // The wallet asks who is in its frame after each load.
      if (m.type === "hello") return window.parent.postMessage({ channel: CHANNEL, type: "hello" }, event.origin);
      if (m.type === "ready" && origin === null) {
        origin = event.origin;
        clearTimeout(timer);
        return found(provider);
      }
      if (event.origin !== origin) return;
      if (m.type === "response" && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        if (m.response.ok) resolve(m.response.result);
        else reject(Object.assign(new Error(m.response.error.message), { code: m.response.error.code }));
      } else if (m.type === "event") {
        for (const listener of listeners.get(m.event) ?? []) listener(m.payload);
      }
    });
    window.parent.postMessage({ channel: CHANNEL, type: "hello" }, "*");
  });
}
```

Use it as `const wallet = await framingWallet()`, then `wallet.request({ method, params })` and `wallet.on("grantChanged", listener)`.
