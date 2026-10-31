// What a Sidechain App uses to find ECX wallets on the page.
//
// Discovery is EIP-6963-style: the app dispatches `ecx:requestProvider` on window, and every
// wallet answers with an `ecx:announceProvider` event carrying `{ info, provider }`. No wallet
// claims a fixed `window.*` name, so several wallets can coexist on one page. Opened inside a
// web wallet (ours, in its Apps view, or any other that speaks the same protocol), the app finds
// that wallet first. Where no wallet answers (no extension), discovery can fall back to a web
// wallet the app names, in a popup (`webWallet`).

import { framedWalletProvider } from "./framed";
import { webWalletProvider } from "./web-wallet";

export { framedWalletProvider } from "./framed";
export {
  webWalletProvider, WEB_WALLET_CHANNEL, PROVIDER_ROUTE, PROVIDER_WINDOW,
  type WebWalletHello, type WebWalletReply, type WebWalletRequest, type WebWalletResponse,
} from "./web-wallet";

export const REQUEST_PROVIDER_EVENT = "ecx:requestProvider";
export const ANNOUNCE_PROVIDER_EVENT = "ecx:announceProvider";

export interface ProviderInfo {
  /** Random per page load; tells two announcements of the same wallet apart from two wallets. */
  uuid: string;
  name: string;
  /** A data: URI image. */
  icon: string;
  /** Reverse-DNS id of the wallet, stable across page loads. */
  rdns: string;
}

export interface RequestArguments {
  method: string;
  params?: unknown;
}

/** EIP-1193-style error: `code` is 4001 rejected, 4100 unauthorized, 4200 unsupported, 4900/4901 disconnected. */
export interface ProviderRpcError extends Error {
  code: number;
  data?: unknown;
}

/**
 * What a Sidechain App's Grant lets it ask for: what `connect` and `getGrant` answer. Mirrors the
 * wallet's `GrantScope` (wallet/src/grants.ts); this package depends on nothing of the wallet's.
 */
export interface GrantScope {
  slots: number[];
  methods: string[];
  /** Present (true) only if the user opted the Grant into Blind Signing. */
  blindSigning?: true;
}

/** The Provider's events and what each listener receives. */
export interface ProviderEvents {
  /** The app's Grant changed (widened, revoked, or `disconnect`): its scope now, or null once it has none. */
  grantChanged: GrantScope | null;
}

export interface Provider {
  request(args: RequestArguments): Promise<unknown>;
  on<E extends keyof ProviderEvents>(event: E, listener: (payload: ProviderEvents[E]) => void): void;
  removeListener<E extends keyof ProviderEvents>(event: E, listener: (payload: ProviderEvents[E]) => void): void;
}

export interface ProviderDetail {
  info: ProviderInfo;
  provider: Provider;
}

export type AnnounceProviderEvent = CustomEvent<ProviderDetail>;

/** Calls `listener` for every wallet that announces itself, then asks wallets to announce. Returns an unsubscribe function. */
export function onProviderAnnounced(listener: (detail: ProviderDetail) => void): () => void {
  const handler = (event: Event) => listener((event as AnnounceProviderEvent).detail);
  window.addEventListener(ANNOUNCE_PROVIDER_EVENT, handler);
  window.dispatchEvent(new Event(REQUEST_PROVIDER_EVENT));
  return () => window.removeEventListener(ANNOUNCE_PROVIDER_EVENT, handler);
}

/**
 * Collects the wallets that announce themselves within `timeoutMs`, one entry per wallet. If a web
 * wallet frames this page (any that speaks docs/web-wallet-protocol.md, on any origin), it comes
 * first, and its requests need no click. Otherwise, if no wallet announces itself and the app names
 * a web wallet (`webWallet`, its URL), answers that wallet in a popup, through `webWalletProvider`:
 * its first request must then come from a click. No wallet is the default.
 */
export async function discoverProviders({ timeoutMs = 200, webWallet }: { timeoutMs?: number; webWallet?: string } = {}): Promise<ProviderDetail[]> {
  const found = new Map<string, ProviderDetail>();
  const stop = onProviderAnnounced((detail) => {
    if (detail?.info?.uuid && !found.has(detail.info.uuid)) found.set(detail.info.uuid, detail);
  });
  const [framing] = await Promise.all([
    framedWalletProvider(timeoutMs),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  stop();
  if (framing) return [framing, ...found.values()];
  return found.size === 0 && webWallet !== undefined ? [webWalletProvider(webWallet)] : [...found.values()];
}
