import { goto } from "$app/navigation";
import type { BackgroundMessage, ProviderResponse } from "../../../../extension/src/messages";
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
  else goto("#/", { replaceState: true }).catch(console.error);
}

export const currentView = (): View => "page";
export const canPin = () => false;
export const pinToSide = async () => {};
export const unpin = () => {};
