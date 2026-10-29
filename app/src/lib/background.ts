// The app's only channel to the wallet: messages to the extension background, which holds every
// secret and makes every decision. The app renders what it is given and reports the user's choice.

import type {
  ApprovalPrompt,
  AssetAmount,
  AssetEntry,
  ChainDescription,
  ChainHistory,
  ChainReport,
  ClearView,
  DangerousMode,
  DepositStatus,
  Grant,
  NamedAsset,
  HistoryEntry,
  RefusedDeposit,
  RefusedSend,
  SendResult,
  SlotAddress,
  SlotReport,
  StoredAsset,
  Unit,
  VaultStatus,
} from "@ecx/wallet";

// The shapes the background sends are the wallet package's own types.
export type {
  ApprovalPrompt,
  AssetAmount,
  AssetEntry,
  ChainHistory,
  ChainReport,
  ClearView,
  DangerousMode,
  DepositStatus,
  Grant,
  HistoryEntry,
  RefusedDeposit,
  RefusedSend,
  SendResult,
  SlotReport,
  StoredAsset,
  Unit,
  VaultStatus,
};

type Response<T> = { ok: true; result: T } | { ok: false; error: { code: number; message: string } };

async function send<T>(message: unknown): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as Response<T>;
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

/** The approval's current prompt; waits while the background prepares it. Null once it's over. */
export const getApproval = (id: string) => send<ApprovalPrompt | null>({ kind: "approval.get", id });

export const resolveApproval = (id: string, approved: boolean, options: { blindSigning?: boolean } = {}) =>
  send<null>({ kind: "approval.resolve", id, approved, ...options });

/** Unlocks the wallet from an approval window; throws on a wrong password. */
export const unlockApproval = (id: string, password: string) => send<null>({ kind: "approval.unlock", id, password });

export const vaultStatus = () => send<VaultStatus>({ kind: "vault.status" });

/** A fresh Master Mnemonic to show once for backup; nothing is stored until `createVault`. */
export const generateMnemonic = async () =>
  (await send<{ masterMnemonic: string }>({ kind: "vault.generate" })).masterMnemonic;

/** Stores the (new or imported) Master Mnemonic encrypted under `password`; leaves it unlocked. */
export const createVault = (args: { masterMnemonic: string; passphrase?: string; password: string }) =>
  send<VaultStatus>({ kind: "vault.create", ...args });

export const unlockVault = (password: string) => send<VaultStatus>({ kind: "vault.unlock", password });

export const lockVault = () => send<VaultStatus>({ kind: "vault.lock" });

/** The port use is reported on: no replies, so a page may close (as the approval window does) mid-report. */
export const ACTIVITY_PORT = "vault.activity";

/** Reports that someone is using this page: activity, moving the auto-lock deadline. Returns the stop. */
export function activityReporter(): { used(): void; stop(): void } {
  let port: chrome.runtime.Port | undefined;
  return {
    used() {
      if (port === undefined) {
        const opened = chrome.runtime.connect({ name: ACTIVITY_PORT });
        opened.onDisconnect.addListener(() => (port = undefined));
        port = opened;
      }
      port.postMessage("used");
    },
    stop: () => port?.disconnect(),
  };
}

/** The background's prefix for a page that shows its own request's approval (extension/src/messages.ts). */
const APPROVAL_HOST_PORT = "approval.host:";

/**
 * Shows this page's own request's approval here, not in a window, which would take focus and close
 * the toolbar popup: pass `host` with the request; `onshow` gets each approval's id, and null once
 * there's none to show. `stop` once the request settles; closing the page rejects it.
 */
export function hostApprovals(onshow: (id: string | null) => void): { host: string; stop(): void } {
  const host = crypto.randomUUID();
  const port = chrome.runtime.connect({ name: `${APPROVAL_HOST_PORT}${host}` });
  port.onMessage.addListener((message: { id?: string | null }) => onshow(message?.id ?? null));
  return {
    host,
    stop() {
      port.disconnect();
      onshow(null);
    },
  };
}

/**
 * From the side panel: shows the approvals of the sites in its browser window here, rather than in
 * windows of their own. `onchange` gets the approvals waiting, oldest first; a closed one leaves
 * the list. Closing the panel rejects them, as closing their window would. Returns the stop.
 */
export function hostPanelApprovals(onchange: (ids: string[]) => void): () => void {
  let ids: string[] = [];
  let port: chrome.runtime.Port | undefined;
  let stopped = false;
  chrome.windows.getCurrent().then((w) => {
    if (stopped || w.id === undefined) return;
    port = chrome.runtime.connect({ name: `${APPROVAL_HOST_PORT}panel:${w.id}` });
    port.onMessage.addListener((message: { id?: string | null; closed?: string }) => {
      if (typeof message?.id === "string" && !ids.includes(message.id)) ids = [...ids, message.id];
      if (typeof message?.closed === "string") ids = ids.filter((id) => id !== message.closed);
      onchange(ids);
    });
  }, () => {});
  return () => {
    stopped = true;
    port?.disconnect();
  };
}

/** Calls `onchange` with each new auto-lock deadline the background announces (null once locked); returns the unsubscribe. */
export function onLockDeadline(onchange: (locksAt: number | null) => void): () => void {
  const listener = (message: unknown) => {
    const m = message as { kind?: string; locksAt?: number | null };
    if (m?.kind === "vault.deadline") onchange(m.locksAt ?? null);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** Calls `onchange` with the chains the wallet just sent a transaction on (a Send, a trade, a Deposit); returns the unsubscribe. */
export function onChainsChanged(onchange: (ids: ChainId[]) => void): () => void {
  const listener = (message: unknown) => {
    const m = message as { kind?: string; ids?: ChainId[] };
    if (m?.kind === "chains.changed" && Array.isArray(m.ids)) onchange(m.ids);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

/** Passwords shorter than this are refused (the background enforces it too). */
export const MIN_PASSWORD_LENGTH = 8;

/** Checks a new password and its repetition; returns an error message or "". */
export function checkNewPassword(password: string, repeat: string): string {
  if (password.length < MIN_PASSWORD_LENGTH) return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== repeat) return "The passwords don't match.";
  return "";
}

/** One Slot's account: its receive address(es) in the chain's own encoding. */
export interface SlotAccount {
  slot: number;
  addresses: SlotAddress[];
}

/** Every Slot the wallet has a Chain Module for (needs the wallet unlocked). */
export const listAccounts = () => send<SlotAccount[]>({ kind: "accounts.list" });

/** A chain as the app names it: `l1` for eCash, the root, else its Slot. */
export type ChainId = "l1" | number;

/** How the wallet shows a chain, from its Chain Entry: its name, what it's for, and the assets it names. */
export interface ChainInfo extends ChainDescription {
  id: ChainId;
  /** The user has it on: shown, counted and read. The main chain always is. */
  on: boolean;
}

/** eCash first, then every Slot the wallet has a Chain Module for. Works while locked. */
export const listChains = () => send<ChainInfo[]>({ kind: "chains.list" });

/** Turns a sidechain on or off. Off, it's hidden and never read; the funds on it stay where they are. */
export const setChainOn = (slot: number, on: boolean) => send<null>({ kind: "chains.setOn", slot, on });

/** How every ECX amount is shown: in ECX (the default) or in sats. */
export const getUnit = () => send<Unit>({ kind: "settings.unit" });

export const setUnit = (unit: Unit) => send<Unit>({ kind: "settings.setUnit", unit });

/** How often a shown wallet reads its chains again, in seconds (`REREAD_SECONDS`: 15 to 300, a minute by default). */
export const getRereadSeconds = () => send<number>({ kind: "settings.rereadSeconds" });

export const setRereadSeconds = (seconds: number) => send<number>({ kind: "settings.setRereadSeconds", seconds });

/** Whether the toolbar button opens the wallet pinned to the side (see `$lib/view`) instead of in its popup. */
export const getPinned = () => send<boolean>({ kind: "view.pinned" });

export const setPinned = (pinned: boolean) => send<boolean>({ kind: "view.setPinned", pinned });

/** eCash's own account: its receive address (needs the wallet unlocked). */
export const l1Account = () => send<{ addresses: SlotAddress[] }>({ kind: "l1.account" });

/** What eCash's server reports for the wallet's L1 addresses. `unattended`: the page reads again by itself, which isn't activity (the auto-lock). */
export const l1Reported = (unattended?: boolean) => send<ChainReport>({ kind: "l1.reported", unattended });

/** eCash's last report this session (null if none), to show while `l1Reported` refreshes it. */
export const l1Cached = () => send<ChainReport | null>({ kind: "l1.cached" });

/** The Slot's last report this session (null if none), to show while `reportedState` refreshes it. */
export const cachedState = (slot: number) => send<SlotReport | null>({ kind: "accounts.cached", slot });

/**
 * A card's balance: the last report shown at once (if this session has one) while a fresh one is
 * read; `error` if that failed (the last report, if any, stays, labelled with when it was read).
 */
export interface ShownReport<R extends { readAt: number } = ChainReport> {
  report?: R;
  refreshing: boolean;
  error?: string;
}

/** Reads `cached` then `fresh`, calling `show` with each state in turn. */
export function showReport<R extends { readAt: number }>(cached: () => Promise<R | null>, fresh: () => Promise<R>, show: (shown: ShownReport<R>) => void) {
  let current: ShownReport<R> = { refreshing: true };
  const update = (next: ShownReport<R>) => show((current = next));
  update(current);
  cached().then(
    (report) => {
      if (report && current.refreshing && current.report === undefined) update({ ...current, report });
    },
    () => {},
  );
  fresh().then(
    (report) => update({ report, refreshing: false }),
    (e) => update({ report: current.report, refreshing: false, error: (e as Error).message }),
  );
}

/** Registers the Slot's addresses with its Sidechain Server and returns what the server reports. */
export const reportedState = (slot: number, unattended?: boolean) => send<SlotReport>({ kind: "accounts.reported", slot, unattended });

/** The transactions the chain's server reports: a Slot's, or eCash's when `slot` is undefined. */
export const reportedHistory = (slot?: number, unattended?: boolean) => send<ChainHistory>({ kind: "history.reported", slot, unattended });

/** The chain's last history this session (null if none), to show while `reportedHistory` refreshes it. */
export const cachedHistory = (slot?: number) => send<ChainHistory | null>({ kind: "history.cached", slot });

/**
 * Sends from the wallet's own Send screen, to one or more recipients: the Slot's Chain Module builds
 * the transfer (over Esplora) or its Sidechain Server does (`/v1`), the user reviews it in an
 * approval window, the wallet signs it and broadcasts or submits it. Throws on refusal or rejection.
 */
export const startSend = (slot: number, outputs: { asset: string; amount: string; to: { address: string } }[], host?: string) =>
  send<SendResult>({ kind: "send.start", slot, outputs, host });

/** Per asset, what a Send on the Slot can spend now (confirmed, plus the wallet's own trusted change). */
export const spendable = (slot: number) => send<AssetAmount[]>({ kind: "send.spendable", slot });

/** The Slot's last Send that failed after approval this session (null if none or closed). */
export const refusedSend = (slot: number) => send<RefusedSend | null>({ kind: "send.refused", slot });

/** Closes the Slot's refused Send. */
export const dismissRefusedSend = (slot: number) => send<null>({ kind: "send.dismissRefused", slot });

/**
 * Deposits `amount` sats of confirmed eCash to the Slot: the wallet builds the M5, the user reviews
 * it in an approval window, the wallet signs and broadcasts it. Throws on refusal or rejection.
 */
export const startDeposit = (order: { slot: number; amount: string }, host?: string) =>
  send<{ txid: string; server: string }>({ kind: "deposit.start", ...order, host });

/** The Slot's pending Deposits and where each stands. */
export const listDeposits = (slot: number, unattended?: boolean) => send<DepositStatus[]>({ kind: "deposit.list", slot, unattended });

/** Stops watching a Deposit. */
export const dismissDeposit = (txid: string) => send<null>({ kind: "deposit.dismiss", txid });

/** The Slot's last Deposit that failed after approval this session, or null. */
export const refusedDeposit = (slot: number) => send<RefusedDeposit | null>({ kind: "deposit.refused", slot });

/** Forgets the Slot's refused Deposit. */
export const dismissRefusedDeposit = (slot: number) => send<null>({ kind: "deposit.dismissRefused", slot });

/** The assets the wallet names on the Slot's network beyond its Chain Entry (docs/adr/0010). */
export const listStoredAssets = (slot: number) => send<StoredAsset[]>({ kind: "assets.list", slot });

/** Names an asset by its contract (exact JSON), once checked against the chain; throws, saying why, if it isn't. */
export const addAssetByContract = (slot: number, asset: string, contract: string) =>
  send<StoredAsset>({ kind: "assets.addByContract", slot, asset, contract });

/** Names a Flush asset from the transaction that registered it, once checked; throws, saying why, if it can't be. */
export const addAssetByRegistration = (slot: number, asset: string) => send<StoredAsset>({ kind: "assets.addByRegistration", slot, asset });

/** Names the Flush assets a report showed unnamed, from their registrations and logos; answers the chain's names. */
export const nameFromRegistrations = (slot: number, assets: string[]) => send<NamedAsset[]>({ kind: "assets.nameFromRegistrations", slot, assets });

/** The user's own name for an asset with no contract, or a new one for an earlier label. */
export const labelAsset = (slot: number, asset: string, label: { name: string; ticker: string; precision: number }) =>
  send<StoredAsset>({ kind: "assets.label", slot, asset, ...label });

/** Forgets an asset's stored name: it shows as an unknown asset again. */
export const removeAsset = (slot: number, asset: string) => send<null>({ kind: "assets.remove", slot, asset });

export const listGrants = () => send<Grant[]>({ kind: "grants.list" });

export const revokeGrant = (origin: string) => send<null>({ kind: "grants.revoke", origin });
