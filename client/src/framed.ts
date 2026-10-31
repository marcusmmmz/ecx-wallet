// A Sidechain App inside a web wallet (#91), such as ours in its Apps view: the wallet frames it
// and is its Provider. Loaded only by apps (the wallet imports ./web-wallet.ts, not this): on load, a framed
// page says `hello` to its parent.
import type { ProviderDetail } from "./index";
import { detail, HELLO, link, WEB_WALLET_CHANNEL, type WebWalletHello, type WebWalletReply } from "./web-wallet";

/** Framed (`parent` is another page): the parent's origin, once it answered `ready`. */
let framedBy: string | undefined;
const framedHeard = new Set<() => void>();
const framed = typeof window !== "undefined" && window.parent !== window;
if (framed) {
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as WebWalletReply | WebWalletHello | undefined;
    if (event.source !== window.parent || data?.channel !== WEB_WALLET_CHANNEL || event.origin === "null") return;
    // The wallet asks after each load of its frame: this page says it's here. `hello` carries
    // nothing, and only that parent's origin hears it.
    if (data.type === "hello") window.parent.postMessage(HELLO, event.origin);
    else if (data.type === "ready" && framedBy === undefined) {
      framedBy = event.origin;
      framedHeard.forEach((heard) => heard());
    }
  });
  // On load, before the app looks for a wallet. Any parent may hear that this page is an app.
  window.parent.postMessage(HELLO, "*");
}

/**
 * The wallet framing this page as a Provider, or null if its parent doesn't say `ready` within
 * `timeoutMs`. Any wallet that speaks this protocol (docs/web-wallet-protocol.md) counts, on any
 * origin: the user opened the app inside it. Named by that origin, as the browser reports it.
 * Requests need no click and open no window.
 */
export function framedWalletProvider(timeoutMs: number): Promise<ProviderDetail | null> {
  const make = (origin: string) =>
    detail(link(origin, () => window.parent, { reloads: false, ready: true }).provider(() => window.parent, "Unreachable."), {
      name: `Wallet at ${origin}`,
      rdns: new URL(origin).hostname.split(".").reverse().join("."),
    });
  if (!framed) return Promise.resolve(null);
  if (framedBy !== undefined) return Promise.resolve(make(framedBy));
  return new Promise((resolve) => {
    const heard = () => {
      done();
      resolve(make(framedBy!));
    };
    const done = () => {
      clearTimeout(timer);
      framedHeard.delete(heard);
    };
    const timer = setTimeout(() => {
      done();
      resolve(null);
    }, timeoutMs);
    framedHeard.add(heard);
  });
}
