// Background: Chromium service worker / Firefox background script.
// Every listener is registered synchronously; WASM is fetched lazily inside the router.
import { scopeOf, type Grant, type KeyValueStore } from "@ecx/wallet";
import { ACTIVITY_PORT, APPROVAL_HOST_PORT, type BackgroundMessage, type GrantChangedMessage, type ProviderResponse } from "./messages";
import { createRouter, type RouterHost } from "./router";

const AUTO_LOCK_ALARM = "vault:auto-lock";

function keyValueStore(area: chrome.storage.StorageArea): KeyValueStore {
  return {
    get: async <T>(key: string) => (await area.get(key))[key] as T | undefined,
    set: (key, value) => area.set({ [key]: value }),
    keys: async () => Object.keys(await area.get(null)),
    remove: (key) => area.remove(key),
  };
}

/** The requester's web origin as the browser reports it for a content-script message. */
function requesterOrigin(sender: chrome.runtime.MessageSender): string | undefined {
  if (sender.id !== chrome.runtime.id || sender.tab === undefined || sender.frameId !== 0) return undefined;
  const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : undefined);
  return origin?.startsWith("https://") || origin?.startsWith("http://") ? origin : undefined;
}

/** True for messages from the wallet's own pages (e.g. the approval window), never from web pages. */
function fromWalletPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && (sender.url?.startsWith(chrome.runtime.getURL("")) ?? false);
}

// Where the toolbar button opens the wallet: its popup, or pinned to the side (Chromium's side
// panel, Firefox's sidebar). Kept in `storage.local` and applied on every start: the browser
// forgets `action.setPopup` when it restarts.
const PINNED_KEY = "view.pinned";
const POPUP = "index.html?view=popup";
const sidebarAction = (globalThis as { browser?: { sidebarAction?: { toggle(): Promise<void> } } }).browser?.sidebarAction;

const pinned = async () => (await chrome.storage.local.get(PINNED_KEY))[PINNED_KEY] === true;

async function applyPinned(on: boolean) {
  await chrome.action.setPopup({ popup: on ? "" : POPUP });
  await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: on });
}

pinned().then(applyPinned).catch(console.error);
// With no popup, Chromium opens its side panel itself; Firefox calls this, still in the click.
chrome.action.onClicked.addListener(() => {
  sidebarAction?.toggle().catch(console.error);
});

/**
 * Tells the origin's open pages its Grant is now `grant` (none: null). Every tab's top frame gets
 * it, and its content script passes it on only to a page of that origin: the wallet needs no tab
 * permission, and no other site sees it.
 */
async function announceGrant(origin: string, grant: Grant | undefined): Promise<void> {
  const message: GrantChangedMessage = { kind: "grantChanged", origin, scope: grant === undefined ? null : scopeOf(grant) };
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, message, { frameId: 0 }).catch(() => {});
  }
}

// The listener is registered before any asynchronous surface creation can finish.
const approvalClosed = new Map<number, () => void>();
chrome.windows.onRemoved.addListener((id) => {
  approvalClosed.get(id)?.();
  approvalClosed.delete(id);
});

const host: RouterHost<chrome.runtime.MessageSender> = {
  persistent: keyValueStore(chrome.storage.local),
  session: keyValueStore(chrome.storage.session),
  fetchWasm: (file) => fetch(chrome.runtime.getURL(file)).then((response) => response.arrayBuffer()),
  requester: (sender) => ({ walletPage: fromWalletPage(sender), origin: requesterOrigin(sender) }),
  async scheduleAutoLock(deadline) {
    if (deadline === null) await chrome.alarms.clear(AUTO_LOCK_ALARM);
    else await chrome.alarms.create(AUTO_LOCK_ALARM, { when: deadline });
  },
  async openApproval(id, onClosed) {
    const window = await chrome.windows.create({ url: chrome.runtime.getURL(`index.html#/approve/${id}`), type: "popup", width: 420, height: 640 });
    const windowId = window?.id;
    if (windowId === undefined) return undefined;
    approvalClosed.set(windowId, onClosed);
    return { close: () => chrome.windows.remove(windowId) };
  },
  announceDeadline: (locksAt) => chrome.runtime.sendMessage({ kind: "vault.deadline", locksAt }),
  announceChains: (ids) => chrome.runtime.sendMessage({ kind: "chains.changed", ids }),
  announceGrant,
  applyPinned,
};
const router = createRouter(host);

// The deadline is also enforced on every use; the alarm clears the key even if nothing asks.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) router.checkAutoLock().catch(console.error);
});

// Activity has no reply: a page may close mid-report.
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender === undefined || !fromWalletPage(port.sender)) return;
  if (port.name === ACTIVITY_PORT) port.onMessage.addListener(() => router.activity().catch(console.error));
  if (port.name.startsWith(APPROVAL_HOST_PORT)) {
    router.connectApprovalHost(port.name.slice(APPROVAL_HOST_PORT.length), {
      send: (message) => port.postMessage(message),
      onClose: (listener) => port.onDisconnect.addListener(listener),
    });
  }
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  router.route(message, sender).then(
    (result): void => sendResponse({ ok: true, result } satisfies ProviderResponse),
    (error): void => sendResponse(router.toErrorResponse(error)),
  );
  return true; // respond asynchronously
});
