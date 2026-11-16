// The Sidechain App docked beside the wallet (#91): the Apps view opens it, the layout frames it on
// the left and keeps the wallet on the right, where every screen still works, until it's closed.
// Kept for the tab (`sessionStorage`), so a reload opens it again.
const KEY = "ecx-docked-app";

/**
 * `url` as an app to frame: only a web page (http or https), never one of the wallet's own, which
 * the frame's `allow-same-origin` would let reach into the wallet. Undefined for anything else.
 */
export function appPage(url: string): string | undefined {
  try {
    const u = new URL(url);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.origin === location.origin) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

function kept(): string | undefined {
  try {
    const url = sessionStorage.getItem(KEY);
    return url === null ? undefined : appPage(url);
  } catch {
    return undefined;
  }
}

export const dock = $state<{ url: string | undefined }>({ url: typeof window === "undefined" ? undefined : kept() });

/** Docks the app at `url`; false, and nothing docked, if it isn't a web page `appPage` takes. */
export function dockApp(url: string): boolean {
  const page = appPage(url);
  if (page === undefined) return false;
  dock.url = page;
  try {
    sessionStorage.setItem(KEY, page);
  } catch {
    // Not kept: a reload shows the wallet alone.
  }
  return true;
}

export function closeDockedApp(): void {
  dock.url = undefined;
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Nothing kept to forget.
  }
}
