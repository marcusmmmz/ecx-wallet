// Message shapes between the extension's contexts.
//
//   page (inpage.ts, main world) --window.postMessage--> content.ts (isolated world)
//     --runtime.sendMessage--> background.ts --> wallet's Provider handler
//
// The inpage Provider and the content script only relay. The background derives the requester's
// origin from the browser-supplied `sender`, never from anything inside the message.

import type { GrantScope, ProviderEvents } from "@ecx/client";

/** window.postMessage channel tags, so the two sides ignore everything else on the page. */
export const TO_CONTENT = "ecx:to-content";
export const TO_INPAGE = "ecx:to-inpage";

export type ProviderResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: number; message: string } };

export interface RelayRequest {
  channel: typeof TO_CONTENT;
  id: string;
  method: unknown;
  params: unknown;
}

export interface RelayResponse {
  channel: typeof TO_INPAGE;
  id: string;
  response: ProviderResponse;
}

/** A Provider event, relayed to the page: no `id`, since it answers no request. */
export interface RelayEvent<E extends keyof ProviderEvents = keyof ProviderEvents> {
  channel: typeof TO_INPAGE;
  event: E;
  payload: ProviderEvents[E];
}

/**
 * Sent by the background to every tab's top frame when an origin's Grant changes; each content
 * script relays it to its page only if `origin` is the page's own.
 */
export interface GrantChangedMessage {
  kind: "grantChanged";
  origin: string;
  scope: GrantScope | null;
}

/** runtime messages handled by the background. */
export type BackgroundMessage =
  | { kind: "provider.request"; method: unknown; params: unknown }
  | { kind: "approval.get"; id: string }
  | { kind: "approval.resolve"; id: string; approved: boolean; blindSigning?: boolean }
  // Unlock from an approval window (a Signing Request that arrived while locked).
  | { kind: "approval.unlock"; id: string; password: string }
  | { kind: "grants.list" }
  | { kind: "grants.revoke"; origin: string }
  // Accounts (receive addresses per Slot): accepted only from the wallet's own pages.
  | { kind: "accounts.list" }
  // How the wallet shows each chain (its Chain Entry's name, description and assets): wallet pages only.
  | { kind: "chains.list" }
  // The asset store, per Slot's network (docs/adr/0010): wallet pages only.
  | { kind: "assets.list"; slot: number }
  | { kind: "assets.label"; slot: number; asset: string; name: string; ticker: string; precision: number }
  | { kind: "assets.remove"; slot: number; asset: string }
  // Names an asset by its contract (exact JSON), checked against the Slot's chain: wallet pages only.
  | { kind: "assets.addByContract"; slot: number; asset: string; contract: string }
  // Names a Flush asset from its registration, checked against the Slot's chain: wallet pages only.
  | { kind: "assets.addByRegistration"; slot: number; asset: string }
  // Names the Flush assets a report showed unnamed, each from its registration and logo: wallet pages only.
  | { kind: "assets.nameFromRegistrations"; slot: number; assets: string[] }
  // Turns a sidechain on or off (the main chain is always on): wallet pages only.
  | { kind: "chains.setOn"; slot: number; on: boolean }
  // Display settings: wallet pages only.
  | { kind: "settings.unit" }
  | { kind: "settings.setUnit"; unit: string }
  // How often a shown wallet reads its chains again, in seconds (15 to 300).
  | { kind: "settings.rereadSeconds" }
  | { kind: "settings.setRereadSeconds"; seconds: number }
  // Whether the toolbar button opens the wallet pinned to the side instead of in its popup: wallet pages only.
  | { kind: "view.pinned" }
  | { kind: "view.setPinned"; pinned: boolean }
  | { kind: "l1.account" }
  // `unattended`: the page reads again by itself, which doesn't count as activity (the auto-lock).
  | { kind: "l1.reported"; unattended?: boolean }
  // The last reports this session, to show while the above refresh them: wallet pages only.
  | { kind: "l1.cached" }
  | { kind: "accounts.cached"; slot: number }
  // Pull path (what the Slot's server reports for the addresses the wallet watches): wallet pages only.
  | { kind: "accounts.reported"; slot: number; unattended?: boolean }
  // A chain's transactions (a Slot's, or eCash's when `slot` is absent), and this session's last: wallet pages only.
  | { kind: "history.reported"; slot?: number; unattended?: boolean; older?: boolean }
  | { kind: "history.cached"; slot?: number }
  // The wallet's own Send (pull path): wallet pages only.
  /** The `send.*` kinds act on the main chain when `slot` is absent, as `history.*` do. */
  | { kind: "send.start"; slot?: number; outputs: { asset: string; amount: string; to: { address: string } }[]; host?: string }
  | { kind: "send.spendable"; slot?: number }
  | { kind: "send.refused"; slot?: number }
  | { kind: "send.dismissRefused"; slot?: number }
  // Deposit from the main chain to a Slot, and the Slot's pending Deposits: wallet pages only.
  | { kind: "deposit.start"; slot: number; amount: string; host?: string }
  | { kind: "deposit.list"; slot: number; unattended?: boolean }
  | { kind: "deposit.dismiss"; txid: string }
  | { kind: "deposit.refused"; slot: number }
  | { kind: "deposit.dismissRefused"; slot: number }
  // Vault: accepted only from the wallet's own pages.
  | { kind: "vault.status" }
  | { kind: "vault.generate" }
  | { kind: "vault.create"; masterMnemonic: string; passphrase?: string; password: string }
  | { kind: "vault.unlock"; password: string }
  | { kind: "vault.lock" }
  | { kind: "vault.setAutoLock"; minutes: number };

/** The port wallet pages report use on (activity for the auto-lock): one "used" message per use. */
export const ACTIVITY_PORT = "vault.activity";

/**
 * A wallet page that shows its own request's approval (the Send or Deposit screen, in the toolbar
 * popup, which closes if a window takes focus) connects as `approval.host:<host>` and passes the
 * same `host` with the request. The background posts `ApprovalHostMessage`s on it instead of
 * opening a window; the page disconnecting counts as closing that window.
 */
export const APPROVAL_HOST_PORT = "approval.host:";

/** An approval for the hosting page to show (`id`), or none left to show (`id` null). */
export interface ApprovalHostMessage {
  id: string | null;
}
