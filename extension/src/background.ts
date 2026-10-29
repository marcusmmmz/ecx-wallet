// Background: Chromium service worker / Firefox background script.
//
// MV3 rules this file must keep:
// - every listener is registered synchronously at top level;
// - no top-level await; WASM is fetched and instantiated lazily inside handlers.
import {
  CACHE_PREFIX,
  scopeOf,
  createAccounts,
  createAssets,
  createChainModules,
  createDeposits,
  esploraClient,
  esploraConfig,
  createL1Module,
  createProviderHandler,
  providerPending,
  createPullPath,
  createSends,
  createSettings,
  describeChain,
  servedNetwork,
  sidechainServer,
  SidechainServerError,
  SUPPORTED_SLOTS,
  createVault,
  ErrorCode,
  loadVaultModule,
  ProviderRpcError,
  VaultError,
  type ApprovalPrompt,
  type AssetPrompt,
  type ChainEntry,
  type NetworkEntry,
  type ConnectAnswer,
  type ConnectPrompt,
  type TurnOnPrompt,
  type DepositStore,
  type Grant,
  type HeldSpend,
  type HeldStore,
  type TransferOutput,
  type UsedLinks,
  type GrantStore,
  type KeyValueStore,
  type PendingDeposit,
  type SessionCache,
  type TradeStore,
  type ApprovalContext,
  type SigningApproval,
  type VaultModule,
} from "@ecx/wallet";
import { ACTIVITY_PORT, APPROVAL_HOST_PORT, type ApprovalHostMessage, type BackgroundMessage, type GrantChangedMessage, type ProviderResponse } from "./messages";

/** Error code for Vault failures reported to the wallet's own pages (wrong password, ...). */
const VAULT_ERROR = -32000;
/** Error code for a Sidechain Server that couldn't be reached or refused, reported to the wallet's own pages. */
const SIDECHAIN_SERVER_ERROR = -32001;
const AUTO_LOCK_ALARM = "vault:auto-lock";

function keyValueStore(area: chrome.storage.StorageArea): KeyValueStore {
  return {
    get: async <T>(key: string) => (await area.get(key))[key] as T | undefined,
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

/** A shipped .wasm's bytes, from the extension package. */
const fetchWasm = (file: string) => fetch(chrome.runtime.getURL(file)).then((response) => response.arrayBuffer());

let vaultModule: Promise<VaultModule> | undefined;
/** vault.wasm, instantiated on first use (and again after each worker restart). */
function loadVault(): Promise<VaultModule> {
  vaultModule ??= fetchWasm("vault.wasm")
    .then(loadVaultModule)
    .catch((error) => {
      vaultModule = undefined;
      throw error;
    });
  return vaultModule;
}

/**
 * The Vault. Its unlock state lives in `storage.session` (memory-only, cleared on browser close,
 * not exposed to content scripts), so it survives this worker being stopped and restarted.
 */
const vault = createVault({
  module: loadVault,
  persistent: keyValueStore(chrome.storage.local),
  session: keyValueStore(chrome.storage.session),
  random: (length) => crypto.getRandomValues(new Uint8Array(length)),
  now: () => Date.now(),
  onDeadline: async (deadline) => {
    if (deadline === null) {
      chrome.alarms.clear(AUTO_LOCK_ALARM).catch(() => {});
      // Awaited: once locked, nothing kept for the session is left.
      await forgetSessionCache().catch(console.error);
    } else chrome.alarms.create(AUTO_LOCK_ALARM, { when: deadline }).catch(() => {});
    // Open wallet pages count down to it. None may be open: then nobody receives this.
    chrome.runtime.sendMessage({ kind: "vault.deadline", locksAt: deadline }).catch(() => {});
  },
});

/**
 * What the wallet keeps for the session to answer faster: passed identity checks, the last
 * reported balances, raw transactions (wallet/src/cache.ts). In `storage.session`, so never on
 * disk; read and written only while unlocked, and forgotten on lock.
 */
const sessionCache: SessionCache = {
  async get<T>(key: string) {
    if (!(await vault.status()).unlocked) return undefined;
    return (await chrome.storage.session.get(key))[key] as T | undefined;
  },
  async set(key, value) {
    if ((await vault.status()).unlocked) await chrome.storage.session.set({ [key]: value });
  },
};

async function forgetSessionCache(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  await chrome.storage.session.remove(Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX)));
}

// The deadline is also enforced on every use; the alarm clears the key even if nothing asks.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_LOCK_ALARM) vault.checkAutoLock().catch(console.error);
});

const GRANT_PREFIX = "grant:";
const grantKey = (origin: string) => `${GRANT_PREFIX}${origin}`;

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

const grants: GrantStore = {
  async get(origin) {
    const key = grantKey(origin);
    return (await chrome.storage.local.get(key))[key] as Grant | undefined;
  },
  async put(grant) {
    await chrome.storage.local.set({ [grantKey(grant.origin)]: grant });
    await announceGrant(grant.origin, grant);
  },
  async remove(origin) {
    const had = (await grants.get(origin)) !== undefined;
    await chrome.storage.local.remove(grantKey(origin));
    if (had) await announceGrant(origin, undefined);
  },
  async list() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(GRANT_PREFIX))
      .map(([, grant]) => grant as Grant);
  },
};

// Deposits the wallet broadcast and still watches, until credited or dismissed.
const DEPOSIT_PREFIX = "deposit:";

const depositStore: DepositStore = {
  async list() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(DEPOSIT_PREFIX))
      .map(([, deposit]) => deposit as PendingDeposit);
  },
  async put(deposit) {
    await chrome.storage.local.set({ [`${DEPOSIT_PREFIX}${deposit.txid}`]: deposit });
  },
  async remove(txid) {
    await chrome.storage.local.remove(`${DEPOSIT_PREFIX}${txid}`);
  },
};

// Coins a broadcast Send spent, held back from later Sends until it confirms (wallet/src/send.ts).
const HELD_PREFIX = "held:";

const heldStore: HeldStore = {
  async list() {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(HELD_PREFIX))
      .map(([, held]) => held as HeldSpend);
  },
  async put(held) {
    await chrome.storage.local.set({ [`${HELD_PREFIX}${held.txid}`]: held });
  },
  async remove(txid) {
    await chrome.storage.local.remove(`${HELD_PREFIX}${txid}`);
  },
};

// Approval windows. Their state lives in memory. Provisional: if the worker is stopped while an
// approval window is open, the request is lost and the page gets 4900 from the content script.

/** The user's answer; null when the window was closed. */
type ApprovalAnswer = { approved: boolean; blindSigning?: boolean } | null;

/**
 * One window that can ask several questions in turn (unlock, then approve). The page asks for the
 * current prompt (`approval.get`), which waits while the background prepares the next one.
 */
class ApprovalWindow {
  readonly id = crypto.randomUUID();
  windowId?: number;
  /** The wallet page showing it in place of a window, once open there (`APPROVAL_HOST_PORT`). */
  private hostPort?: chrome.runtime.Port;

  /** `host`: a wallet page that shows this approval itself, if it is still open. */
  constructor(private readonly host?: string) {}
  private opened = false;
  private closed = false;
  private current = deferred<ApprovalPrompt | null>();
  private answer?: (answer: ApprovalAnswer) => void;

  /** When the page last sent this approval a message (ms), so `close` doesn't cut off a reply. */
  private contacted = 0;

  /** Records contact from the page: it asked for a prompt, answered one, or unlocked. */
  private touch(): void {
    this.contacted = Date.now();
  }

  /** Pages waiting in `prompt()`, however long ago they asked. */
  private prompting = 0;

  /** The prompt the page should show now (waits while the next one is being prepared). */
  prompt(): Promise<ApprovalPrompt | null> {
    this.touch();
    this.prompting++;
    return this.current.promise.finally(() => this.prompting--);
  }

  /** Shows `prompt` (opening the window on first use) and resolves with the user's answer. */
  ask(prompt: ApprovalPrompt): Promise<ApprovalAnswer> {
    if (this.closed) return Promise.resolve(null);
    const answered = new Promise<ApprovalAnswer>((resolve) => (this.answer = resolve));
    this.current.resolve(prompt);
    if (!this.opened) this.open();
    return answered;
  }

  /** Records the user's answer; the page then waits for the next prompt, if any. */
  settle(answer: ApprovalAnswer): void {
    this.touch();
    const resolve = this.answer;
    this.answer = undefined;
    this.current = deferred();
    resolve?.(answer);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // A page that just sent a message may still be waiting on the reply (Firefox logs one cut off).
    const waiting = this.prompting > 0 || Date.now() - this.contacted < CLOSE_GRACE_MS;
    approvals.delete(this.id);
    this.settle(null);
    this.current.resolve(null);
    if (this.hostPort !== undefined) {
      try {
        this.hostPort.onDisconnect.removeListener(this.hostClosed);
        this.hostPort.postMessage({ id: null, closed: this.id } satisfies ApprovalHostMessage);
      } catch {
        // The page is gone.
      }
      return;
    }
    const windowId = this.windowId;
    if (windowId === undefined) return;
    const remove = () => chrome.windows.remove(windowId).catch(() => {});
    // Such a page gets its reply, is told there's nothing left, and closes itself; this is the fallback.
    if (waiting) setTimeout(remove, CLOSE_GRACE_MS);
    else remove();
  }

  /** The hosting page closed: as closing the window, a rejection. */
  private readonly hostClosed = () => this.close();

  private open(): void {
    this.opened = true;
    approvals.set(this.id, this);
    const port = this.host === undefined ? undefined : approvalHosts.get(this.host);
    if (port !== undefined) {
      this.hostPort = port;
      port.onDisconnect.addListener(this.hostClosed);
      port.postMessage({ id: this.id } satisfies ApprovalHostMessage);
      return;
    }
    chrome.windows
      .create({ url: chrome.runtime.getURL(`index.html#/approve/${this.id}`), type: "popup", width: 420, height: 640 })
      .then((window) => {
        this.windowId = window?.id;
        if (this.closed && window?.id !== undefined) chrome.windows.remove(window.id).catch(() => {});
      }, () => this.close());
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const approvals = new Map<string, ApprovalWindow>();

/**
 * Wallet pages that show approvals themselves, by the `host` they connected as: a page's own
 * request's (a random id), or, for the side panel open in a browser window, the approvals of the
 * sites in that window (`panelHost`).
 */
const approvalHosts = new Map<string, chrome.runtime.Port>();

/** The host a side panel registers as for the browser window it's open in (`APPROVAL_HOST_PORT`). */
const panelHost = (windowId: number | undefined) => (windowId === undefined || windowId < 0 ? undefined : `panel:${windowId}`);

/** How long a page told there's nothing left to approve has to close itself before it's closed. */
const CLOSE_GRACE_MS = 1_000;

async function askToConnect(prompt: ConnectPrompt, host?: string): Promise<ConnectAnswer> {
  const approval = new ApprovalWindow(host);
  try {
    const answer = await approval.ask({ kind: "connect", ...prompt });
    return { approved: answer?.approved === true, blindSigning: answer?.approved === true && answer.blindSigning === true };
  } finally {
    approval.close();
  }
}

async function askToNameAsset(prompt: AssetPrompt, host?: string): Promise<boolean> {
  const approval = new ApprovalWindow(host);
  try {
    return (await approval.ask({ kind: "suggestAsset", ...prompt }))?.approved === true;
  } finally {
    approval.close();
  }
}

async function askToTurnOn(prompt: TurnOnPrompt, host?: string): Promise<boolean> {
  const approval = new ApprovalWindow(host);
  try {
    return (await approval.ask({ kind: "turnOn", ...prompt }))?.approved === true;
  } finally {
    approval.close();
  }
}

function openSigningApproval(context: ApprovalContext): SigningApproval {
  const approval = new ApprovalWindow(context.host);
  return {
    unlock: async () => (await approval.ask({ kind: "unlock", ...context }))?.approved === true,
    confirm: async (prompt) => (await approval.ask({ kind: "sign", ...prompt }))?.approved === true,
    close: () => approval.close(),
  };
}

// Closing the approval window counts as rejecting. A browser window's Provider handler goes with it.
chrome.windows.onRemoved.addListener((windowId) => {
  providerHandlers.delete(panelHost(windowId)!);
  for (const approval of approvals.values()) if (approval.windowId === windowId) approval.close();
});

// Each Chain Module runs in its own WASM instance (instantiated on first use) and gets only its
// own key, per call: a Slot's module that Slot's Starter, eCash's module the L1 Account Key.
const chainModule = createChainModules(fetchWasm);
const l1Module = createL1Module(fetchWasm);
const keys = { starter: (slot: number) => vault.starter(slot), l1AccountKey: () => vault.l1AccountKey() };
const accounts = createAccounts({ ...keys, chainModule, l1Module });
const settings = createSettings(keyValueStore(chrome.storage.local));

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

/** Every chain's description, eCash first: what its Chain Entry says. */
const describeChains = async () => [
  { id: "l1" as const, ...describeChain(await l1Module()) },
  ...(await Promise.all(SUPPORTED_SLOTS.map(async (slot) => ({ id: slot, ...describeChain(await chainModule(slot)!) })))),
];

/** The assets the wallet names beyond its Chain Entries, per network (docs/adr/0010). Not encrypted, like Grants. */
const assets = createAssets({
  store: keyValueStore(chrome.storage.local),
  entryAssets: async (chain) => (await describeChains()).find((c) => c.chain === chain)?.assets ?? [],
});

/** The chain a Slot's module serves (CAIP-2): the key its on/off setting is stored under. */
const slotChain = async (slot: number) => (await chainModule(slot)!).declare().binding.chain;

/** Sidechains the user has on: off until turned on, never polled while off (the main chain is always on). */
const chainsOn = {
  isOn: async (slot: number) => settings.chainOn(await slotChain(slot)),
  turnOn: async (slot: number) => settings.setChainOn(await slotChain(slot), true),
};

/** A wallet page's Slot whose chain is on: nothing reads a chain the user has off. */
async function onSlot(slot: unknown): Promise<number> {
  const n = supportedSlot(slot);
  if (!(await chainsOn.isOn(n))) {
    const { name } = describeChain(await chainModule(n)!);
    throw new ProviderRpcError(ErrorCode.ChainDisconnected, `${name} is turned off.`);
  }
  return n;
}

/** One review for every Signing Request, whichever path it came by. */
const signing = {
  openSigningApproval,
  supportedSlots: SUPPORTED_SLOTS,
  isUnlocked: async () => (await vault.status()).unlocked,
  chainModule,
  starter: keys.starter,
  now: () => Date.now(),
  rememberSigned: assets.rememberSigned,
};

/** A read a shown page makes by itself (`unattended`, see `Chains.watch`) doesn't count as activity. */
function byItself<T>(message: { unattended?: boolean }, read: () => Promise<T>): Promise<T> {
  return message.unattended === true ? vault.unattended(read) : read();
}

/**
 * Tells open wallet pages that the wallet sent on these chains, once `run` settles (sent or not:
 * reading again is harmless), so they show it without a Retry. None may be open.
 */
function announcing<T>(ids: ("l1" | number)[], run: Promise<T>): Promise<T> {
  return run.finally(() => chrome.runtime.sendMessage({ kind: "chains.changed", ids }).catch(() => {}));
}

/**
 * The Provider's handler for a site's requests from one browser window: their approvals show in
 * the wallet's side panel (or Firefox's sidebar) when it's open in that window (`panelHost`),
 * else in a window of their own. What waits on the user per origin (one unlock window, one asset
 * suggestion) is shared by every window's handler, so a site can't open one per window.
 */
const providerHandlers = new Map<string, ReturnType<typeof createProviderHandler>>();
const pendingPerOrigin = providerPending();
function providerHandler(host: string | undefined) {
  const key = host ?? "";
  let handler = providerHandlers.get(key);
  if (handler === undefined) {
    handler = createProviderHandler(providerDeps(host));
    providerHandlers.set(key, handler);
  }
  return handler;
}

const providerDeps = (host: string | undefined): Parameters<typeof createProviderHandler>[0] => ({
  ...signing,
  openSigningApproval: (context) => openSigningApproval({ ...context, ...(host === undefined ? {} : { host }) }),
  grants,
  askToConnect: (prompt) => askToConnect(prompt, host),
  askToTurnOn: (prompt) => askToTurnOn(prompt, host),
  chains: chainsOn,
  receiveAddresses: (slot) => accounts.receiveAddresses(slot),
  send: (slot, order, from) => announcing([slot], sends.send(slot, order, from, host)),
  sendAction: (slot, action, from) => announcing([slot], sends.trade(slot, action, from, host)),
  askToNameAsset: (prompt) => askToNameAsset(prompt, host),
  pending: pendingPerOrigin,
  async assetSuggestion(slot, origin, suggestion) {
    const module = await chainModule(slot)!;
    const { entry, network } = servedNetwork(module);
    // A contract is checked against the chain, which only an Esplora server says how to do.
    const client = network.sidechainServer.api === "esplora" ? esplora(entry, network) : undefined;
    const { chain, asset, replaces } = await assets.suggestion(module, client, origin, suggestion);
    return { chain, asset, ...(replaces ? { replaces } : {}) };
  },
  saveAsset: (chain, asset) => assets.save(chain, asset),
  async assetBalance(slot, asset) {
    // The suggestion needs no key, so this never asks to unlock just to show a balance.
    if (!(await vault.status()).unlocked) return { locked: true };
    try {
      const report = await pullPath.reportedState(slot);
      const of = (list: { asset: string; amount: string }[]) => list.find((b) => b.asset === asset)?.amount ?? "0";
      return { amount: of(report.balances), unconfirmed: of(report.unconfirmed) };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

/** The assets `assets.nameFromRegistrations` already tried this session, per chain (CAIP-2). */
const triedRegistrations = new Map<string, Set<string>>();

/** What a transaction's outputs carry, by its Slot's module, if that declares `tokens` (Flush, docs/adr/0013). */
const tokensOn = (entry: ChainEntry) => async (tx: string) => {
  const module = entry.slot === undefined ? undefined : await chainModule(entry.slot);
  return module?.declare().capabilities.includes("tokens") ? module.outputTokens(tx) : undefined;
};

/**
 * What Flush's market index said of the wallet's trades in final blocks (docs/adr/0017): it can't
 * change, so it's kept for good, in plain `storage.local` like pending Deposits.
 */
const tradeStore: TradeStore = keyValueStore(chrome.storage.local);

// The pull path: each Slot's Sidechain Server, in the Server API its Chain Entry names.
const pullPath = createPullPath({
  ...signing,
  ...keys,
  l1Module,
  sidechainServer: (entry, network) => sidechainServer(entry, network, undefined, sessionCache, tokensOn(entry), tradeStore),
  cache: sessionCache,
});

/** A client for a network's default server, which speaks Esplora (Flush's included). */
const esplora = (entry: ChainEntry, network: NetworkEntry) => esploraClient(esploraConfig(entry, network, sessionCache), (...args) => fetch(...args));

// Deposits: the L1 module builds the M5 from the wallet's own coins, over eCash's Esplora.
const deposits = createDeposits({
  ...keys,
  chainModule,
  l1Module,
  openSigningApproval,
  isUnlocked: signing.isUnlocked,
  esplora,
  store: depositStore,
  cache: sessionCache,
  now: () => Date.now(),
});

// The wallet's own Send: over Esplora the Slot's module builds it; a `/v1` server builds its own.
/** Links whose trade went out (docs/adr/0016): `storage.session`, so kept across lock and forgotten when the browser closes. */
const usedLinks: UsedLinks = {
  has: async (digest) => (await chrome.storage.session.get(`usedLink:${digest}`))[`usedLink:${digest}`] !== undefined,
  add: (digest) => chrome.storage.session.set({ [`usedLink:${digest}`]: true }),
};

const sends = createSends({ ...keys, chainModule, l1Module, pullPath, esplora, openSigningApproval, isUnlocked: signing.isUnlocked, held: heldStore, usedLinks, cache: sessionCache, tradeStore, now: () => Date.now() });

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

/** True for the wallet's side panel (Chromium) or sidebar (Firefox): its page, in its panel view. */
function isPanel(sender: chrome.runtime.MessageSender): boolean {
  if (!fromWalletPage(sender) || sender.tab !== undefined || sender.url === undefined) return false;
  return new URL(sender.url).searchParams.get("view") === "panel";
}

/** The page a wallet page's request names to show its approval (`APPROVAL_HOST_PORT`), if any. */
const hostOf = (message: { host?: unknown }) => (typeof message.host === "string" && message.host !== "" ? message.host : undefined);

/** A wallet page's `slot`, if the wallet has a Chain Module for it. */
function supportedSlot(slot: unknown): number {
  const n = Number(slot);
  if (!SUPPORTED_SLOTS.includes(n)) throw new ProviderRpcError(ErrorCode.ChainDisconnected, "No Chain Module for that Slot.");
  return n;
}

async function route(message: BackgroundMessage, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message?.kind) {
    case "provider.request": {
      const origin = requesterOrigin(sender);
      if (origin === undefined) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      // Where its approvals show is the browser's word (the tab's window), never the request's.
      return providerHandler(panelHost(sender.tab?.windowId))(origin, message.method, message.params);
    }
    case "approval.get":
      if (!fromWalletPage(sender)) return null;
      return (await approvals.get(message.id)?.prompt()) ?? null;
    case "approval.resolve":
      if (!fromWalletPage(sender)) return null;
      approvals.get(message.id)?.settle({ approved: message.approved === true, blindSigning: message.blindSigning === true });
      return null;
    case "approval.unlock": {
      // Unlocking from an approval window: throws (wrong password) without answering the prompt.
      if (!fromWalletPage(sender)) return null;
      const approval = approvals.get(message.id);
      if (approval === undefined) return null;
      await vault.unlock(String(message.password ?? ""));
      approval.settle({ approved: true });
      return null;
    }
    case "grants.list":
      if (!fromWalletPage(sender)) return null;
      return (await grants.list()).sort((a, b) => a.origin.localeCompare(b.origin));
    case "grants.revoke":
      if (!fromWalletPage(sender)) return null;
      if (typeof message.origin === "string") await grants.remove(message.origin);
      return null;
    case "accounts.list":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      // One entry per Slot with a Chain Module; addresses are public, so the page may show them.
      return Promise.all(
        SUPPORTED_SLOTS.map(async (slot) => ({ slot, addresses: await accounts.receiveAddresses(slot) })),
      );
    case "chains.list":
      // Public: what the Chain Entries say, so the page can name chains and assets even while locked.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      // Each names its Chain Entry's assets, then the asset store's.
      return Promise.all(
        (await describeChains()).map(async (c) => ({ ...c, on: c.id === "l1" || (await chainsOn.isOn(c.id)), assets: await assets.named(c.chain) })),
      );
    case "assets.list":
      // The asset store's entries for a Slot's network, for the Assets screen. Public, like `chains.list`.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return assets.list(await slotChain(supportedSlot(message.slot)));
    case "assets.label":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return assets.label(await slotChain(supportedSlot(message.slot)), String(message.asset ?? ""), {
        name: String(message.name ?? ""),
        ticker: String(message.ticker ?? ""),
        precision: Number(message.precision),
      });
    case "assets.remove":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await assets.remove(await slotChain(supportedSlot(message.slot)), String(message.asset ?? ""));
      return null;
    case "assets.addByContract": {
      // Names an asset by its contract, checked against the chain: answers what was stored.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      const module = await chainModule(await onSlot(message.slot))!;
      const { entry, network } = servedNetwork(module);
      if (network.sidechainServer.api !== "esplora") {
        throw new ProviderRpcError(ErrorCode.InvalidParams, `${entry.name}'s server doesn't say how an asset was issued, so its contract can't be checked.`);
      }
      return assets.addByContract(module, esplora(entry, network), String(message.asset ?? ""), String(message.contract ?? ""));
    }
    case "assets.addByRegistration": {
      // Names a Flush asset from its registration, checked against the chain: answers what was stored.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      const module = await chainModule(await onSlot(message.slot))!;
      const { entry, network } = servedNetwork(module);
      if (network.sidechainServer.api !== "flush") {
        throw new ProviderRpcError(ErrorCode.InvalidParams, `${entry.name}'s server doesn't say which transaction registered an asset.`);
      }
      return assets.addByRegistration(module, esplora(entry, network), String(message.asset ?? ""));
    }
    case "assets.nameFromRegistrations": {
      // Each asset is tried once a session: one that can't be named isn't asked about on every refresh.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      const module = await chainModule(await onSlot(message.slot))!;
      const { entry, network } = servedNetwork(module);
      const chain = module.declare().binding.chain;
      if (network.sidechainServer.api !== "flush") return assets.named(chain);
      const tried = triedRegistrations.get(chain) ?? new Set<string>();
      triedRegistrations.set(chain, tried);
      const ids = (Array.isArray(message.assets) ? message.assets : []).map((a) => String(a).toLowerCase()).filter((a) => !tried.has(a));
      ids.forEach((a) => tried.add(a));
      return assets.nameFromRegistrations(module, esplora(entry, network), ids);
    }
    case "chains.setOn": {
      // Turning a sidechain on or off; the main chain is always on.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      const slot = supportedSlot(message.slot);
      await settings.setChainOn(await slotChain(slot), message.on === true);
      return null;
    }
    case "settings.unit":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return settings.unit();
    case "settings.setUnit":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await settings.setUnit(String(message.unit ?? ""));
      return settings.unit();
    case "settings.rereadSeconds":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return settings.rereadSeconds();
    case "settings.setRereadSeconds":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await settings.setRereadSeconds(Number(message.seconds));
      return settings.rereadSeconds();
    case "view.pinned":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return pinned();
    case "view.setPinned": {
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      const on = message.pinned === true;
      await chrome.storage.local.set({ [PINNED_KEY]: on });
      await applyPinned(on);
      return on;
    }
    case "l1.account":
      // eCash's own account: its receive address and what its server reports are asked separately.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return { addresses: await accounts.l1ReceiveAddresses() };
    case "l1.reported":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return byItself(message, () => pullPath.reportedL1State());
    case "l1.cached":
      // The last report this session, shown while `l1.reported` refreshes it; null if none.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await pullPath.cachedL1State()) ?? null;
    case "accounts.cached":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await pullPath.cachedState(await onSlot(message.slot))) ?? null;
    case "accounts.reported":
      // What a Slot's Sidechain Server reports for the addresses the wallet watches.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      {
        const slot = await onSlot(message.slot);
        return byItself(message, () => pullPath.reportedState(slot));
      }
    case "history.reported":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      {
        const slot = message.slot === undefined ? undefined : await onSlot(message.slot);
        return byItself(message, () => (slot === undefined ? pullPath.l1History() : pullPath.history(slot)));
      }
    case "history.cached":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await (message.slot === undefined ? pullPath.cachedL1History() : pullPath.cachedHistory(await onSlot(message.slot)))) ?? null;
    case "send.start":
      // The wallet's own Send: resolves once broadcast, or once a `/v1` server accepted it.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      {
        const slot = await onSlot(message.slot);
        return announcing([slot], sends.send(slot, { outputs: Array.isArray(message.outputs) ? (message.outputs as TransferOutput[]) : [] }, undefined, hostOf(message)));
      }
    case "send.spendable":
      // What a Send on the Slot can spend now, per asset.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return sends.spendable(await onSlot(message.slot));
    case "send.refused":
      // The Slot's last Send that failed after approval, for the Activity feed: its page may be gone.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await sends.refused(supportedSlot(message.slot))) ?? null;
    case "send.dismissRefused":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await sends.dismissRefused(supportedSlot(message.slot));
      return null;
    case "deposit.start":
      // Resolves once the M5 is broadcast (after the user's approval).
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      {
        const slot = await onSlot(message.slot);
        return announcing(["l1", slot], deposits.start(slot, String(message.amount ?? ""), hostOf(message)));
      }
    case "deposit.list":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return byItself(message, () => deposits.list(supportedSlot(message.slot)));
    case "deposit.dismiss":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await deposits.dismiss(String(message.txid ?? ""));
      return null;
    case "deposit.refused":
      // The Slot's last Deposit that failed after approval, for the home page: its page may be gone.
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return (await deposits.refused(supportedSlot(message.slot))) ?? null;
    case "deposit.dismissRefused":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      await deposits.dismissRefused(supportedSlot(message.slot));
      return null;
    case "vault.status":
    case "vault.generate":
    case "vault.create":
    case "vault.unlock":
    case "vault.lock":
    case "vault.setAutoLock":
      if (!fromWalletPage(sender)) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
      return routeVault(message);
    default:
      throw new ProviderRpcError(ErrorCode.UnsupportedMethod, "Unknown message.");
  }
}

/** Vault requests from the wallet's own pages. Replies carry status only, never secrets. */
async function routeVault(message: Extract<BackgroundMessage, { kind: `vault.${string}` }>): Promise<unknown> {
  switch (message.kind) {
    case "vault.status":
      return vault.status();
    case "vault.generate":
      // The one time a Master Mnemonic leaves the background: to be shown for backup at creation.
      return { masterMnemonic: await vault.generate() };
    case "vault.create":
      await vault.create({
        masterMnemonic: String(message.masterMnemonic ?? ""),
        passphrase: String(message.passphrase ?? ""),
        password: String(message.password ?? ""),
      });
      return vault.status();
    case "vault.unlock":
      await vault.unlock(String(message.password ?? ""));
      return vault.status();
    case "vault.lock":
      await vault.lock();
      return vault.status();
    case "vault.setAutoLock":
      await vault.setAutoLockMinutes(Number(message.minutes));
      return null;
  }
}

// Someone using a wallet page counts as activity for the auto-lock. Over a port, not a message: a
// page may close mid-report (the approval window does, right after a click), and nothing replies.
chrome.runtime.onConnect.addListener((port) => {
  if (port.sender === undefined || !fromWalletPage(port.sender)) return;
  if (port.name === ACTIVITY_PORT) port.onMessage.addListener(() => vault.touch().catch(console.error));
  if (port.name.startsWith(APPROVAL_HOST_PORT)) {
    const host = port.name.slice(APPROVAL_HOST_PORT.length);
    // A window's sites' approvals go only to the wallet's side panel itself.
    if (host.startsWith("panel:") && !isPanel(port.sender)) return port.disconnect();
    approvalHosts.set(host, port);
    port.onDisconnect.addListener(() => approvalHosts.get(host) === port && approvalHosts.delete(host));
  }
});

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  route(message, sender).then(
    (result): void => sendResponse({ ok: true, result } satisfies ProviderResponse),
    (error): void => sendResponse(toErrorResponse(error)),
  );
  return true; // respond asynchronously
});

function toErrorResponse(error: unknown): ProviderResponse {
  if (error instanceof ProviderRpcError) return { ok: false, error: { code: error.code, message: error.message } };
  if (error instanceof VaultError) return { ok: false, error: { code: VAULT_ERROR, message: error.message } };
  if (error instanceof SidechainServerError) return { ok: false, error: { code: SIDECHAIN_SERVER_ERROR, message: error.message } };
  console.error(error);
  return { ok: false, error: { code: ErrorCode.Internal, message: "Internal wallet error." } };
}
