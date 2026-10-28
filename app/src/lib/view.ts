// Where this page shows: the toolbar popup, pinned to the side of the browser window (Chromium's
// side panel, Firefox's sidebar), or a window or tab of its own. The manifest names the first two
// by `?view=`; the approval window and tabs open `index.html` without it.

import { setPinned } from "./background";

export type View = "popup" | "panel" | "page";

type SidebarAction = { open(): Promise<void>; close(): Promise<void> };
const sidebarAction = () => (globalThis as { browser?: { sidebarAction?: SidebarAction } }).browser?.sidebarAction;

export function currentView(): View {
  if (typeof location === "undefined") return "page";
  const view = new URLSearchParams(location.search).get("view");
  return view === "popup" || view === "panel" ? view : "page";
}

/** True where this browser can pin the wallet to the side. */
export const canPin = () => chrome.sidePanel?.open !== undefined || sidebarAction() !== undefined;

// Chromium opens a side panel only within a click, so the window's id is read ahead of it.
let windowId: number | undefined;
if (currentView() === "popup" && chrome.sidePanel?.open !== undefined) {
  chrome.windows.getCurrent().then((w) => (windowId = w.id));
}

/**
 * From the popup: opens the wallet pinned to the side, makes the toolbar button open it there
 * from now on, and closes the popup. Call it straight from the click.
 */
export async function pinToSide() {
  const sidebar = sidebarAction();
  const opened = sidebar !== undefined ? sidebar.open() : chrome.sidePanel.open({ windowId: windowId! });
  await opened;
  await setPinned(true);
  window.close();
}

/**
 * From the side: makes the toolbar button open the popup again, and closes the side panel.
 * Firefox closes its sidebar only within the click, so there it doesn't wait for the background:
 * the message is already on its way when the page goes.
 */
export function unpin() {
  const sidebar = sidebarAction();
  if (sidebar === undefined) return void setPinned(false).finally(() => window.close());
  setPinned(false).catch(() => {});
  sidebar.close();
}
