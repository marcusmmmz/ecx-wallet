// The web wallet as a Provider (#8, #85, #91): a page can't inject one, so the app reaches the
// wallet's window over `postMessage`. Either the wallet frames the app (its Apps view, #91) and the
// app talks to `parent` (./framed.ts), or the app opens the wallet in a popup at `#/provider` (#85).
// The wallet imports this module too, so it has no side effects. Each side
// checks the other's origin as the browser reports it (`event.origin`); the wallet takes the
// requester from there, never from a message.
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
 * Asks the other side to say it's there. From an app: to a Provider window it found already open
 * (e.g. after the app reloaded), or to the wallet framing it; the wallet answers `ready`. From the
 * wallet: to the page it frames, after each load, since the frame may now hold another site; a
 * framed app answers with its own `hello`.
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

export const HELLO: WebWalletHello = { channel: WEB_WALLET_CHANNEL, type: "hello" };

class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * What both ways in share: requests waiting on the wallet's window, and the replies and events
 * from it. `current()` is that window, if there is one; only its messages, from `walletOrigin`,
 * are heard. `reloads`: a second `ready` means the window reloaded, losing what it was answering.
 * `ready`: the window already said it was.
 */
export function link(walletOrigin: string, current: () => Window | null, { reloads, ready = false }: { reloads: boolean; ready?: boolean }) {
  type Pending = { message: WebWalletRequest; resolve(result: unknown): void; reject(error: Error): void; sent: boolean };
  const pending = new Map<string, Pending>();
  type Listener = (payload: ProviderEvents[keyof ProviderEvents]) => void;
  const listeners = new Map<keyof ProviderEvents, Set<Listener>>();

  function fail(which: (p: Pending) => boolean, message: string) {
    for (const [id, p] of pending) {
      if (!which(p)) continue;
      pending.delete(id);
      p.reject(new ProviderRpcError(4900, message));
    }
  }

  function flush() {
    const target = current();
    if (target === null) return;
    for (const p of pending.values()) {
      if (p.sent) continue;
      p.sent = true;
      target.postMessage(p.message, walletOrigin);
    }
  }

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as WebWalletReply | undefined;
    const target = current();
    if (target === null || event.source !== target || event.origin !== walletOrigin || data?.channel !== WEB_WALLET_CHANNEL) return;
    if (data.type === "ready") {
      if (ready && reloads) fail((p) => p.sent, "The wallet window reloaded.");
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

  return {
    fail,
    /** The window went away or was replaced: wait for its `ready` again. */
    unready: () => (ready = false),
    /** A request for the window `open()` gives (null: the browser blocked it, failing with `blocked`). */
    provider(open: () => Window | null, blocked: string): Provider {
      return Object.freeze({
        request({ method, params }: RequestArguments): Promise<unknown> {
          return new Promise((resolve, reject) => {
            const target = open();
            if (target === null) return reject(new ProviderRpcError(4900, blocked));
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
    },
  };
}

/** `name` and `rdns`: ours unless given (a framing wallet we can only name by its origin). */
export function detail(provider: Provider, { name = "ECX Wallet (web)", rdns = "cash.ecx.wallet.web" }: { name?: string; rdns?: string } = {}): ProviderDetail {
  return Object.freeze({
    info: Object.freeze({ uuid: crypto.randomUUID(), name, icon: ICON, rdns }),
    provider,
  });
}

/**
 * The web wallet at `walletUrl` as a Provider. The first request opens the wallet's window, so
 * make it from a click: browsers block a popup opened any other way, and the request then fails
 * with 4900. Closing the window disconnects; the next request opens it again, locked.
 */
export function webWalletProvider(walletUrl: string): ProviderDetail {
  const url = new URL(walletUrl);
  url.hash = PROVIDER_ROUTE;
  let popup: Window | null = null;
  let poll: ReturnType<typeof setInterval> | undefined;
  const wallet = link(url.origin, () => popup, { reloads: true });

  /** The wallet's window, opened if it isn't; null if the browser blocked it. */
  function walletWindow(): Window | null {
    if (popup !== null && !popup.closed) return popup;
    // Closed before the poll noticed: what it was answering is gone.
    if (popup !== null) wallet.fail((p) => p.sent, "The wallet window was closed.");
    // An empty URL finds a window of that name as it is: opening the wallet's URL in one already
    // open would reload it, dropping its session and whatever it was answering.
    popup = window.open("", PROVIDER_WINDOW, "popup,width=420,height=680");
    wallet.unready();
    clearInterval(poll);
    if (popup === null) return null;
    let fresh = false;
    try {
      // Readable only while it is this app's own new about:blank.
      fresh = popup.location.href === "about:blank";
    } catch {
      // Another origin's: the wallet's, already open (e.g. before the app reloaded).
    }
    // It won't load again, so ask it to say `ready`.
    if (fresh) popup.location.href = url.href;
    else popup.postMessage(HELLO, url.origin);
    poll = setInterval(() => {
      if (!popup?.closed) return;
      clearInterval(poll);
      popup = null;
      wallet.unready();
      wallet.fail(() => true, "The wallet window was closed.");
    }, CLOSED_POLL_MS);
    return popup;
  }

  return detail(wallet.provider(walletWindow, "The browser blocked the wallet window. Ask again from a click."));
}
