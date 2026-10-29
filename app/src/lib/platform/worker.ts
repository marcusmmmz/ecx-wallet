// A dedicated Worker owns this page's wallet session; a reload drops every unlocked key.
import { createIndexedDBStore, createMemoryStore } from "@ecx/wallet";
import { createRouter, type RouterHost } from "../../../../extension/src/router";
import { ACTIVITY_PORT, APPROVAL_HOST_PORT } from "../../../../extension/src/messages";
import type { FromWorker, ToWorker } from "./types";

const post = (message: FromWorker) => self.postMessage(message);
let timer: ReturnType<typeof setTimeout> | undefined;
const approvals = new Map<string, () => void>();
const ports = new Map<number, { name: string; closed: (() => void)[] }>();

const host: RouterHost<void> = {
  persistent: createIndexedDBStore("ecx-wallet"),
  session: createMemoryStore(),
  async fetchWasm(file) {
    const response = await fetch(new URL(`${import.meta.env.BASE_URL}${file}`, self.location.origin));
    if (!response.ok) throw new Error(`Couldn't load ${file}: ${response.status}`);
    return response.arrayBuffer();
  },
  // This channel belongs only to the wallet page. No message can attest a dApp's origin.
  requester: () => ({ walletPage: true, origin: undefined }),
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
  async applyPinned() {},
};
const router = createRouter(host);

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  switch (m.type) {
    case "request":
      router.route(m.message, undefined).then(
        (result) => post({ type: "response", id: m.id, response: { ok: true, result } }),
        (error) => post({ type: "response", id: m.id, response: router.toErrorResponse(error) }),
      );
      break;
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
