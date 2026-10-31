import { goto } from "$app/navigation";
import type { BackgroundMessage, ProviderResponse } from "../../../../extension/src/messages";
import { WEB_WALLET_CHANNEL, type WebWalletHello, type WebWalletReply, type WebWalletRequest } from "../../../../client/src/web-wallet";
import type { FromWorker, ToWorker, TransportPort } from "./types";
export type { TransportPort } from "./types";
export type View = "page" | "popup" | "panel";

const listeners = new Set<(message: unknown) => void>();
const pending = new Map<number, { resolve(response: ProviderResponse): void; reject(error: Error): void }>();
const ports = new Map<number, { messages: ((message: unknown) => void)[]; closed: (() => void)[] }>();
let sequence = 0;
let worker: Worker | undefined;
let failure: Error | undefined;
let approval: { id: string; back: string; opening?: Promise<void> } | undefined;
/**
 * Grant changes, between this origin's pages: each page has its own Worker, so a Grant revoked in
 * one tab must still reach the app that a Provider window in another serves.
 */
const GRANTS_CHANNEL = "ecx-wallet:grantChanged";
let grantsOut: BroadcastChannel | undefined;

function post(message: ToWorker): void {
  if (failure) throw failure;
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const m = event.data;
      switch (m.type) {
        case "response":
          pending.get(m.id)?.resolve(m.response);
          pending.delete(m.id);
          break;
        case "announce":
          listeners.forEach((listener) => listener(m.message));
          // Every Provider window hears it there, this page's own included.
          if ((m.message as { kind?: string })?.kind === "grantChanged") (grantsOut ??= new BroadcastChannel(GRANTS_CHANNEL)).postMessage(m.message);
          break;
        case "portMessage":
          ports.get(m.id)?.messages.forEach((listener) => listener(m.message));
          break;
        case "openApproval":
          // Only one surface fits in the page; replacing it cancels its previous request.
          const back = approval?.back ?? (location.hash || "#/");
          closeSurface(false);
          approval = { id: m.id, back };
          approval.opening = goto(`#/approve/${m.id}`);
          approval.opening.catch(() => {
            if (approval?.id === m.id) closeSurface(false);
          });
          break;
        case "closeApproval":
          if (approval?.id === m.id) closeSurface(true);
          break;
      }
    };
    worker.onerror = () => {
      failure = new Error("The wallet Worker stopped. Reload to unlock again.");
      pending.forEach(({ reject }) => reject(failure!));
      pending.clear();
      ports.forEach((port) => port.closed.forEach((listener) => listener()));
      ports.clear();
      worker?.terminate();
    };
    // A hidden tab can throttle both timers; recheck before it resumes work on screen.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !failure) post({ type: "checkAutoLock" });
    });
  }
  worker.postMessage(message);
}

export function request(message: unknown): Promise<ProviderResponse> {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    try { post({ type: "request", id, message: message as BackgroundMessage }); }
    catch (error) { pending.delete(id); reject(error); }
  });
}

export function onMessage(listener: (message: unknown) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function connect(name: string): TransportPort {
  const id = ++sequence;
  const port = { messages: [] as ((message: unknown) => void)[], closed: [] as (() => void)[] };
  ports.set(id, port);
  post({ type: "connect", id, name });
  return {
    postMessage: (message) => post({ type: "portMessage", id, message }),
    disconnect() {
      if (!ports.delete(id)) return;
      post({ type: "disconnect", id });
      port.closed.forEach((listener) => listener());
    },
    onMessage: { addListener: (listener) => { port.messages.push(listener); } },
    onDisconnect: { addListener: (listener) => { port.closed.push(listener); } },
  };
}

function closeSurface(back: boolean): void {
  const previous = approval;
  if (!previous) return;
  approval = undefined;
  post({ type: "approvalClosed", id: previous.id });
  // A request may finish before its route has opened. Wait for it before returning.
  if (back) previous.opening?.then(() => {
    if (!approval && location.hash === `#/approve/${previous.id}`) return goto(previous.back, { replaceState: true });
  }).catch(console.error);
}

export function approvalRouteChanged(path: string): void {
  if (approval && path !== `/approve/${approval.id}`) closeSurface(false);
}

export function closeApproval(): void {
  if (approval) closeSurface(true);
  // An approval this page no longer has (it reloaded): a Provider window goes back to serving.
  else goto(onApp === undefined ? "#/" : "#/provider", { replaceState: true }).catch(console.error);
}

/** Apps that asked through this page's Provider window, and who to tell about a new one. */
const appOrigins = new Set<string>();
let onApp: ((origin: string) => void) | undefined;

/**
 * Makes this page the Provider window of the app that opened it (`#/provider`, #85): it answers
 * Provider requests from `window.opener` only, as from the origin the browser reports for each
 * message, and passes that origin's Grant changes back. False if no page opened this one.
 * `onAppOrigin` hears each origin that asks, once.
 */
export function serveOpener(onAppOrigin: (origin: string) => void): boolean {
  const opener = window.opener as Window | null;
  if (opener === null) return false;
  const first = onApp === undefined;
  onApp = onAppOrigin;
  appOrigins.forEach(onAppOrigin);
  if (!first) return true;
  const reply = (message: WebWalletReply, origin: string) => opener.postMessage(message, origin);
  const ready = () => reply({ channel: WEB_WALLET_CHANNEL, type: "ready" }, "*");
  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as WebWalletRequest | WebWalletHello | undefined;
    if (event.source !== opener || data?.channel !== WEB_WALLET_CHANNEL) return;
    // The app found this window already open: it has nothing in flight here.
    if (data.type === "hello") return ready();
    if (data.type !== "request" || typeof data.id !== "string") return;
    // An opaque origin ("null") can't hold a Grant; this origin is the wallet's own pages.
    const origin = event.origin;
    if (!/^https?:\/\//.test(origin) || origin === location.origin) return;
    if (!appOrigins.has(origin)) {
      appOrigins.add(origin);
      onApp?.(origin);
    }
    const answer = (response: ProviderResponse) => reply({ channel: WEB_WALLET_CHANNEL, type: "response", id: data.id, response }, origin);
    const id = ++sequence;
    pending.set(id, { resolve: answer, reject: (error) => answer({ ok: false, error: { code: 4900, message: error.message } }) });
    try { post({ type: "appRequest", id, origin, method: data.method, params: data.params }); }
    catch (error) { pending.delete(id); answer({ ok: false, error: { code: 4900, message: (error as Error).message } }); }
  });
  new BroadcastChannel(GRANTS_CHANNEL).onmessage = ({ data }: MessageEvent) => {
    const m = data as { kind?: string; origin?: string; scope?: unknown };
    // Sent to that origin only: if the opener has since gone elsewhere, the browser drops it.
    if (m?.kind === "grantChanged" && typeof m.origin === "string" && appOrigins.has(m.origin)) {
      reply({ channel: WEB_WALLET_CHANNEL, type: "event", event: "grantChanged", payload: m.scope as never }, m.origin);
    }
  };
  // Carries nothing but readiness, so any origin may read it.
  ready();
  return true;
}

export const currentView = (): View => "page";
export const canPin = () => false;
export const pinToSide = async () => {};
export const unpin = () => {};
