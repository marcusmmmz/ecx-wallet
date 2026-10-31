import type { BackgroundMessage, ProviderResponse } from "../../../../extension/src/messages";

export interface TransportPort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

// Private Worker envelopes; the wallet messages and ProviderResponse stay unchanged.
export type ToWorker =
  | { type: "request"; id: number; message: BackgroundMessage }
  // A Sidechain App's Provider request through this page's Provider window (`#/provider`): `origin`
  // is the app's, as the browser reported it on the message the page received.
  | { type: "appRequest"; id: number; origin: string; method: unknown; params?: unknown }
  | { type: "checkAutoLock" }
  | { type: "approvalClosed"; id: string }
  | { type: "connect"; id: number; name: string }
  | { type: "portMessage"; id: number; message: unknown }
  | { type: "disconnect"; id: number };

export type FromWorker =
  | { type: "response"; id: number; response: ProviderResponse }
  | { type: "announce"; message: unknown }
  | { type: "openApproval" | "closeApproval"; id: string }
  | { type: "portMessage"; id: number; message: unknown };
