// The injected Provider. Runs in the page's main world at document_start. It makes no decisions:
// it announces itself through discovery events, relays each request to the content script and
// hands back whatever answer comes back, and calls the page's listeners for each event relayed.
import {
  ANNOUNCE_PROVIDER_EVENT,
  REQUEST_PROVIDER_EVENT,
  type Provider,
  type ProviderDetail,
  type ProviderEvents,
  type RequestArguments,
} from "@ecx/client";
import { TO_CONTENT, TO_INPAGE, type RelayEvent, type RelayRequest, type RelayResponse } from "./messages";

const ICON =
  "data:image/svg+xml;base64," +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0b6e4f"/></svg>');

const pending = new Map<string, (response: RelayResponse["response"]) => void>();
type Listener = (payload: ProviderEvents[keyof ProviderEvents]) => void;
const listeners = new Map<keyof ProviderEvents, Set<Listener>>();

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as RelayResponse | RelayEvent | undefined;
  if (event.source !== window || data?.channel !== TO_INPAGE) return;
  if ("event" in data) {
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
    return;
  }
  const settle = pending.get(data.id);
  if (!settle) return;
  pending.delete(data.id);
  settle(data.response);
});

class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const provider: Provider = Object.freeze({
  request({ method, params }: RequestArguments): Promise<unknown> {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pending.set(id, (response) =>
        response.ok ? resolve(response.result) : reject(new ProviderRpcError(response.error.code, response.error.message)),
      );
      const message: RelayRequest = { channel: TO_CONTENT, id, method, params };
      window.postMessage(message, window.location.origin);
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

const detail: ProviderDetail = Object.freeze({
  info: Object.freeze({ uuid: crypto.randomUUID(), name: "ECX Wallet", icon: ICON, rdns: "cash.ecx.wallet" }),
  provider,
});

function announce() {
  window.dispatchEvent(new CustomEvent(ANNOUNCE_PROVIDER_EVENT, { detail }));
}

window.addEventListener(REQUEST_PROVIDER_EVENT, announce);
announce();

// `window.flush` (docs/adr/0016): how flush.markets finds a wallet. Its two methods go through the
// same relay, so the background decides everything. A page that already has one (another wallet's)
// keeps it.
const FLUSH_METHODS: readonly unknown[] = ["flush_requestAddress", "flush_submit"];
if (!("flush" in window)) {
  const flush = Object.freeze({
    isFlush: true,
    request: ({ method, params }: RequestArguments): Promise<unknown> =>
      FLUSH_METHODS.includes(method) ? provider.request({ method, params }) : Promise.reject(new ProviderRpcError(4200, `Unsupported method: ${String(method)}`)),
  });
  Object.defineProperty(window, "flush", { value: flush, configurable: true, enumerable: false, writable: false });
}
