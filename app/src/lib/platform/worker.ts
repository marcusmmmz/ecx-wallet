// A dedicated Worker owns this page's wallet session; a reload drops every unlocked key.
import { createIndexedDBStore, createMemoryStore, ErrorCode, ProviderRpcError, scopeOf, SUPPORTED_SLOTS } from "@ecx/wallet";
import { createRouter, type RouterHost } from "../../../../extension/src/router";
import { ACTIVITY_PORT, APPROVAL_HOST_PORT, type BackgroundMessage } from "../../../../extension/src/messages";
import type { FromWorker, ToWorker } from "./types";

const post = (message: FromWorker) => self.postMessage(message);
let timer: ReturnType<typeof setTimeout> | undefined;
const approvals = new Map<string, () => void>();
const ports = new Map<number, { name: string; closed: (() => void)[] }>();

/** A Sidechain App's origin, as the page's Provider window received it; none for the page itself. */
type Sender = { origin: string } | undefined;

const host: RouterHost<Sender> = {
  persistent: createIndexedDBStore("ecx-wallet"),
  session: createMemoryStore(),
  async fetchWasm(file) {
    const response = await fetch(new URL(`${import.meta.env.BASE_URL}${file}`, self.location.origin));
    if (!response.ok) throw new Error(`Couldn't load ${file}: ${response.status}`);
    return response.arrayBuffer();
  },
  // Only `appRequest` names an app, and it carries only Provider requests: everything else on this
  // channel is the wallet page's own.
  requester: (sender) => (sender === undefined ? { walletPage: true, origin: undefined } : { walletPage: false, origin: sender.origin }),
  async scheduleAutoLock(deadline) {
    clearTimeout(timer);
    if (deadline !== null) timer = setTimeout(() => router.checkAutoLock().catch(console.error), Math.max(0, deadline - Date.now()));
  },
  async openApproval(id, onClosed) {
    approvals.set(id, onClosed);
    post({ type: "openApproval", id });
    return { async close() {
      approvals.delete(id);
      post({ type: "closeApproval", id });
    } };
  },
  async announceDeadline(locksAt) { post({ type: "announce", message: { kind: "vault.deadline", locksAt } }); },
  async announceChains(ids) { post({ type: "announce", message: { kind: "chains.changed", ids } }); },
  // The page's Provider window passes it on only to that origin's app.
  async announceGrant(origin, grant) {
    post({ type: "announce", message: { kind: "grantChanged", origin, scope: grant === undefined ? null : scopeOf(grant) } });
  },
  async applyPinned() {},
};
const router = createRouter(host);

/** The spend locks an app's Provider request takes, as the wallet's own Send does (see `request`). */
function appSpendLocks(method: unknown, params: unknown): string[] {
  // `slot` is the app's, unchecked: a value Number() can't convert must not throw here, outside `respond`.
  const { slot } = (params ?? {}) as { slot?: unknown };
  if (method === "sendTransfer" || method === "sendAction") return typeof slot === "number" && SUPPORTED_SLOTS.includes(slot) ? [`ecx-wallet:spend:${slot}`] : [];
  // A `flush:` link trades on whichever Slot is Flush here; lock them all, in one order.
  if (method === "flush_submit") return [...SUPPORTED_SLOTS].sort((a, b) => a - b).map((s) => `ecx-wallet:spend:${s}`);
  return [];
}

function withLocks<T>(names: string[], run: () => Promise<T>): Promise<T> {
  if (names.length === 0) return run();
  const [first, ...rest] = names;
  return navigator.locks.request(first, {}, () => withLocks(rest, run)) as Promise<T>;
}

const respond = (id: number, result: Promise<unknown>) => result.then(
  (result) => post({ type: "response", id, response: { ok: true, result } }),
  (error) => post({ type: "response", id, response: router.toErrorResponse(error) }),
);

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  switch (m.type) {
    case "request": {
      // Separate pages have separate routers, but spend the same IndexedDB-backed wallet.
      // Hold an origin-wide lock for the coins' chain through approval and committed spend
      // records. Deposits share L1 coins, regardless of their destination Slot.
      const spending = m.message?.kind === "send.start" || m.message?.kind === "deposit.start" ? m.message : undefined;
      const controller = new AbortController();
      const port = spending?.host
        ? [...ports.values()].find((port) => port.name === `${APPROVAL_HOST_PORT}${spending.host}`)
        : undefined;
      const onClosed = () => controller.abort();
      port?.closed.push(onClosed);
      const result = spending
        ? navigator.locks.request(`ecx-wallet:spend:${spending.kind === "send.start" ? Number(spending.slot) : "l1"}`, { signal: controller.signal }, () => router.route(spending, undefined))
          .catch((error) => {
            // Leaving a hosted form while it waits for another tab must cancel its request.
            if (controller.signal.aborted) throw new ProviderRpcError(ErrorCode.UserRejected, "User rejected.");
            throw error;
          })
        : router.route(m.message, undefined);
      respond(m.id, result.finally(() => {
        if (port) port.closed = port.closed.filter((listener) => listener !== onClosed);
      }));
      break;
    }
    case "appRequest": {
      const message: BackgroundMessage = { kind: "provider.request", method: m.method, params: m.params };
      respond(m.id, Promise.resolve().then(() => withLocks(appSpendLocks(m.method, m.params), () => router.route(message, { origin: m.origin }))));
      break;
    }
    case "checkAutoLock":
      router.checkAutoLock().catch(console.error);
      break;
    case "approvalClosed":
      approvals.get(m.id)?.();
      approvals.delete(m.id);
      break;
    case "connect": {
      const port = { name: m.name, closed: [] as (() => void)[] };
      ports.set(m.id, port);
      if (m.name.startsWith(APPROVAL_HOST_PORT)) router.connectApprovalHost(m.name.slice(APPROVAL_HOST_PORT.length), {
        send: (message) => post({ type: "portMessage", id: m.id, message }),
        onClose: (listener) => port.closed.push(listener),
      });
      break;
    }
    case "portMessage":
      if (ports.get(m.id)?.name === ACTIVITY_PORT) router.activity().catch(console.error);
      break;
    case "disconnect":
      ports.get(m.id)?.closed.forEach((listener) => listener());
      ports.delete(m.id);
      break;
  }
});
