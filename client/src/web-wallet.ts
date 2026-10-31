// The web wallet as a Provider (#8, #85): a page can't inject one, so the app opens the wallet in a
// popup at `#/provider` and the two talk over `postMessage`. Each side checks the other's origin as
// the browser reports it (`event.origin`); the wallet takes the requester from there, never from
// a message.
import type { Provider, ProviderDetail, ProviderEvents, RequestArguments } from "./index";

/** Tags every message between an app and the web wallet's Provider window. */
export const WEB_WALLET_CHANNEL = "ecx:webWallet";

/** The route the app opens: the wallet's Provider window. */
export const PROVIDER_ROUTE = "/provider";

/** The window name the app opens it under, which it keeps across reloads. */
export const PROVIDER_WINDOW = "ecx-web-wallet";

export type WebWalletResponse = { ok: true; result: unknown } | { ok: false; error: { code: number; message: string } };

/** From the app to the Provider window. */
export interface WebWalletRequest {
  channel: typeof WEB_WALLET_CHANNEL;
  type: "request";
  id: string;
  method: string;
  params?: unknown;
}

/**
 * From the app to a Provider window it found already open (e.g. after the app reloaded): asks it
 * to say `ready` again.
 */
export interface WebWalletHello {
  channel: typeof WEB_WALLET_CHANNEL;
  type: "hello";
}

/**
 * From the Provider window to the app: `ready` once it listens (again after a reload, which drops
 * whatever it was answering), a request's `response`, or an `event` for this app's origin.
 */
export type WebWalletReply =
  | { channel: typeof WEB_WALLET_CHANNEL; type: "ready" }
  | { channel: typeof WEB_WALLET_CHANNEL; type: "response"; id: string; response: WebWalletResponse }
  | { channel: typeof WEB_WALLET_CHANNEL; type: "event"; event: keyof ProviderEvents; payload: ProviderEvents[keyof ProviderEvents] };

const ICON =
  "data:image/svg+xml;base64," +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0b6e4f"/></svg>');

/** How often to check whether the user closed the wallet window. */
const CLOSED_POLL_MS = 300;

class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The web wallet at `walletUrl` as a Provider. The first request opens the wallet's window, so
 * make it from a click: browsers block a popup opened any other way, and the request then fails
 * with 4900. Closing the window disconnects; the next request opens it again, locked.
 */
export function webWalletProvider(walletUrl: string): ProviderDetail {
  const url = new URL(walletUrl);
  url.hash = PROVIDER_ROUTE;
  const walletOrigin = url.origin;

  type Pending = { message: WebWalletRequest; resolve(result: unknown): void; reject(error: Error): void; sent: boolean };
  const pending = new Map<string, Pending>();
  type Listener = (payload: ProviderEvents[keyof ProviderEvents]) => void;
  const listeners = new Map<keyof ProviderEvents, Set<Listener>>();
  let popup: Window | null = null;
  let ready = false;
  let poll: ReturnType<typeof setInterval> | undefined;

  function fail(which: (p: Pending) => boolean, message: string) {
    for (const [id, p] of pending) {
      if (!which(p)) continue;
      pending.delete(id);
      p.reject(new ProviderRpcError(4900, message));
    }
  }

  function flush() {
    for (const p of pending.values()) {
      if (p.sent) continue;
      p.sent = true;
      popup!.postMessage(p.message, walletOrigin);
    }
  }

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as WebWalletReply | undefined;
    if (popup === null || event.source !== popup || event.origin !== walletOrigin || data?.channel !== WEB_WALLET_CHANNEL) return;
    if (data.type === "ready") {
      // A reloaded window is a new session: what it was answering is gone.
      if (ready) fail((p) => p.sent, "The wallet window reloaded.");
      ready = true;
      flush();
    } else if (data.type === "response") {
      const p = pending.get(data.id);
      if (!p) return;
      pending.delete(data.id);
      if (data.response.ok) p.resolve(data.response.result);
      else p.reject(new ProviderRpcError(data.response.error.code, data.response.error.message));
    } else if (data.type === "event") {
      for (const listener of listeners.get(data.event) ?? []) {
        try {
          listener(data.payload);
        } catch (error) {
          // One app listener throwing mustn't stop the others.
          queueMicrotask(() => {
            throw error;
          });
        }
      }
    }
  });

  /** The wallet's window, opened if it isn't; null if the browser blocked it. */
  function walletWindow(): Window | null {
    if (popup !== null && !popup.closed) return popup;
    // Closed before the poll noticed: what it was answering is gone.
    if (popup !== null) fail((p) => p.sent, "The wallet window was closed.");
    // An empty URL finds a window of that name as it is: opening the wallet's URL in one already
    // open would reload it, dropping its session and whatever it was answering.
    popup = window.open("", PROVIDER_WINDOW, "popup,width=420,height=680");
    ready = false;
    clearInterval(poll);
    if (popup === null) return null;
    let fresh = false;
    try {
      // Readable only while it is this app's own new about:blank.
      fresh = popup.location.href === "about:blank";
    } catch {
      // Another origin's: the wallet's, already open (e.g. before the app reloaded).
    }
    if (fresh) popup.location.href = url.href;
    else {
      // It won't load again, so ask it to say `ready`.
      const hello: WebWalletHello = { channel: WEB_WALLET_CHANNEL, type: "hello" };
      popup.postMessage(hello, walletOrigin);
    }
    poll = setInterval(() => {
      if (!popup?.closed) return;
      clearInterval(poll);
      popup = null;
      ready = false;
      fail(() => true, "The wallet window was closed.");
    }, CLOSED_POLL_MS);
    return popup;
  }

  const provider: Provider = Object.freeze({
    request({ method, params }: RequestArguments): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const target = walletWindow();
        if (target === null) return reject(new ProviderRpcError(4900, "The browser blocked the wallet window. Ask again from a click."));
        const id = crypto.randomUUID();
        pending.set(id, { message: { channel: WEB_WALLET_CHANNEL, type: "request", id, method, params }, resolve, reject, sent: false });
        if (ready) flush();
        target.focus();
      });
    },
    on<E extends keyof ProviderEvents>(event: E, listener: (payload: ProviderEvents[E]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener as Listener);
    },
    removeListener<E extends keyof ProviderEvents>(event: E, listener: (payload: ProviderEvents[E]) => void) {
      listeners.get(event)?.delete(listener as Listener);
    },
  });

  return Object.freeze({
    info: Object.freeze({ uuid: crypto.randomUUID(), name: "ECX Wallet (web)", icon: ICON, rdns: "cash.ecx.wallet.web" }),
    provider,
  });
}
