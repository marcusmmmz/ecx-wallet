// Wallet routing shared by the extension and other hosts.
import {
  CACHE_PREFIX,
  createAccounts,
  createAssets,
  createChainModules,
  createDeposits,
  esploraClient,
  esploraConfig,
  createL1Module,
  createProviderHandler,
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
import { type ApprovalHostMessage, type BackgroundMessage, type ProviderResponse } from "./messages";

/** Error code for Vault failures reported to the wallet's own pages (wrong password, ...). */
const VAULT_ERROR = -32000;
/** Error code for a Sidechain Server that couldn't be reached or refused, reported to the wallet's own pages. */
const SIDECHAIN_SERVER_ERROR = -32001;
/** A surface opened for an approval; closing it may race with opening it. */
export interface ApprovalSurface {
  close(): Promise<void>;
}

/** A wallet page showing approvals in place, with no reply needed on disconnect. */
export interface ApprovalHost {
  send(message: ApprovalHostMessage): void;
  onClose(listener: () => void): void;
}

/** Platform operations. Requester identity must come from the transport, never the message. */
export interface RouterHost<Sender> {
  persistent: KeyValueStore;
  session: KeyValueStore;
  fetchWasm(file: string): Promise<ArrayBuffer>;
  requester(sender: Sender): { walletPage: boolean; origin?: string };
  scheduleAutoLock(deadline: number | null): Promise<void>;
  openApproval(id: string, onClosed: () => void): Promise<ApprovalSurface | undefined>;
  announceDeadline(deadline: number | null): Promise<void>;
  announceChains(ids: ("l1" | number)[]): Promise<void>;
  announceGrant?(origin: string, grant: Grant | undefined): Promise<void>;
  applyPinned(on: boolean): Promise<void>;
}

/** One router's state, shared by its requests and transport event handlers. WASM stays lazy. */
export function createRouter<Sender>(host: RouterHost<Sender>) {
  let vaultModule: Promise<VaultModule> | undefined;
  /** vault.wasm, instantiated on first use (and again after each worker restart). */
  function loadVault(): Promise<VaultModule> {
    vaultModule ??= host.fetchWasm("vault.wasm")
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
    persistent: host.persistent,
    session: host.session,
    random: (length) => crypto.getRandomValues(new Uint8Array(length)),
    now: () => Date.now(),
    onDeadline: async (deadline) => {
      if (deadline === null) {
        host.scheduleAutoLock(null).catch(() => {});
        // Awaited: once locked, nothing kept for the session is left.
        await forgetSessionCache().catch(console.error);
      } else host.scheduleAutoLock(deadline).catch(() => {});
      // Open wallet pages count down to it. None may be open: then nobody receives this.
      host.announceDeadline(deadline).catch(() => {});
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
      return host.session.get<T>(key);
    },
    async set(key, value) {
      if ((await vault.status()).unlocked) await host.session.set(key, value);
    },
  };

  async function forgetSessionCache(): Promise<void> {
    const keys = (await host.session.keys()).filter((key) => key.startsWith(CACHE_PREFIX));
    await Promise.all(keys.map((key) => host.session.remove(key)));
  }

  const GRANT_PREFIX = "grant:";
  const grantKey = (origin: string) => `${GRANT_PREFIX}${origin}`;

  const grants: GrantStore = {
    async get(origin) {
      const key = grantKey(origin);
      return host.persistent.get<Grant>(key);
    },
    async put(grant) {
      await host.persistent.set(grantKey(grant.origin), grant);
      await host.announceGrant?.(grant.origin, grant);
    },
    async remove(origin) {
      const had = (await grants.get(origin)) !== undefined;
      await host.persistent.remove(grantKey(origin));
      if (had) await host.announceGrant?.(origin, undefined);
    },
    async list() {
      const keys = (await host.persistent.keys()).filter((key) => key.startsWith(GRANT_PREFIX));
      const values = await Promise.all(keys.map((key) => host.persistent.get<Grant>(key)));
      return values.filter((value): value is Grant => value !== undefined);
    },
  };

  // Deposits the wallet broadcast and still watches, until credited or dismissed.
  const DEPOSIT_PREFIX = "deposit:";

  const depositStore: DepositStore = {
    async list() {
      const keys = (await host.persistent.keys()).filter((key) => key.startsWith(DEPOSIT_PREFIX));
      const values = await Promise.all(keys.map((key) => host.persistent.get<PendingDeposit>(key)));
      return values.filter((value): value is PendingDeposit => value !== undefined);
    },
    async put(deposit) {
      await host.persistent.set(`${DEPOSIT_PREFIX}${deposit.txid}`, deposit);
    },
    async remove(txid) {
      await host.persistent.remove(`${DEPOSIT_PREFIX}${txid}`);
    },
  };

  // Coins a broadcast Send spent, held back from later Sends until it confirms (wallet/src/send.ts).
  const HELD_PREFIX = "held:";

  const heldStore: HeldStore = {
    async list() {
      const keys = (await host.persistent.keys()).filter((key) => key.startsWith(HELD_PREFIX));
      const values = await Promise.all(keys.map((key) => host.persistent.get<HeldSpend>(key)));
      return values.filter((value): value is HeldSpend => value !== undefined);
    },
    async put(held) {
      await host.persistent.set(`${HELD_PREFIX}${held.txid}`, held);
    },
    async remove(txid) {
      await host.persistent.remove(`${HELD_PREFIX}${txid}`);
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
    surface?: ApprovalSurface;
    /** The wallet page showing it in place of a window, once open there (`APPROVAL_HOST_PORT`). */
    private hostPort?: ApprovalHost;

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
          this.hostPort.send({ id: null } satisfies ApprovalHostMessage);
        } catch {
          // The page is gone.
        }
        return;
      }
      const surface = this.surface;
      if (surface === undefined) return;
      const remove = () => surface.close().catch(() => {});
      // Such a page gets its reply, is told there's nothing left, and closes itself; this is the fallback.
      if (waiting) setTimeout(remove, CLOSE_GRACE_MS);
      else remove();
    }

    private open(): void {
      this.opened = true;
      approvals.set(this.id, this);
      const port = this.host === undefined ? undefined : approvalHosts.get(this.host);
      if (port !== undefined) {
        this.hostPort = port;
        port.onClose(() => this.close());
        port.send({ id: this.id } satisfies ApprovalHostMessage);
        return;
      }
      host.openApproval(this.id, () => this.close()).then((surface) => {
        this.surface = surface;
        if (this.closed) surface?.close().catch(() => {});
      }, () => this.close());
    }
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  const approvals = new Map<string, ApprovalWindow>();

  /** Wallet pages that show their own request's approval, by the `host` they connected as. */
  const approvalHosts = new Map<string, ApprovalHost>();

  /** How long a page told there's nothing left to approve has to close itself before it's closed. */
  const CLOSE_GRACE_MS = 1_000;

  async function askToConnect(prompt: ConnectPrompt): Promise<ConnectAnswer> {
    const approval = new ApprovalWindow();
    try {
      const answer = await approval.ask({ kind: "connect", ...prompt });
      return { approved: answer?.approved === true, blindSigning: answer?.approved === true && answer.blindSigning === true };
    } finally {
      approval.close();
    }
  }

  async function askToNameAsset(prompt: AssetPrompt): Promise<boolean> {
    const approval = new ApprovalWindow();
    try {
      return (await approval.ask({ kind: "suggestAsset", ...prompt }))?.approved === true;
    } finally {
      approval.close();
    }
  }

  async function askToTurnOn(prompt: TurnOnPrompt): Promise<boolean> {
    const approval = new ApprovalWindow();
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

  // Each Chain Module runs in its own WASM instance (instantiated on first use) and gets only its
  // own key, per call: a Slot's module that Slot's Starter, eCash's module the L1 Account Key.
  const chainModule = createChainModules(host.fetchWasm);
  const l1Module = createL1Module(host.fetchWasm);
  const keys = { starter: (slot: number) => vault.starter(slot), l1AccountKey: () => vault.l1AccountKey() };
  const accounts = createAccounts({ ...keys, chainModule, l1Module });
  const settings = createSettings(host.persistent);

  const PINNED_KEY = "view.pinned";
  const pinned = async () => (await host.persistent.get(PINNED_KEY)) === true;

  /** Every chain's description, eCash first: what its Chain Entry says. */
  const describeChains = async () => [
    { id: "l1" as const, ...describeChain(await l1Module()) },
    ...(await Promise.all(SUPPORTED_SLOTS.map(async (slot) => ({ id: slot, ...describeChain(await chainModule(slot)!) })))),
  ];

  /** The assets the wallet names beyond its Chain Entries, per network (docs/adr/0010). Not encrypted, like Grants. */
  const assets = createAssets({
    store: host.persistent,
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
    return run.finally(() => host.announceChains(ids).catch(() => {}));
  }

  const handleProviderRequest = createProviderHandler({
    ...signing,
    grants,
    askToConnect,
    askToTurnOn,
    chains: chainsOn,
    receiveAddresses: (slot) => accounts.receiveAddresses(slot),
    send: (slot, order, from) => announcing([slot], sends.send(slot, order, from)),
    sendAction: (slot, action, from) => announcing([slot], sends.trade(slot, action, from)),
    askToNameAsset,
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
  const tradeStore: TradeStore = host.persistent;

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
    has: async (digest) => (await host.session.get(`usedLink:${digest}`)) !== undefined,
    add: (digest) => host.session.set(`usedLink:${digest}`, true),
  };

  const sends = createSends({ ...keys, chainModule, l1Module, pullPath, esplora, openSigningApproval, isUnlocked: signing.isUnlocked, held: heldStore, usedLinks, cache: sessionCache, now: () => Date.now() });

  /** The page a wallet page's request names to show its approval (`APPROVAL_HOST_PORT`), if any. */
  const hostOf = (message: { host?: unknown }) => (typeof message.host === "string" && message.host !== "" ? message.host : undefined);

  /** A wallet page's `slot`, if the wallet has a Chain Module for it. */
  function supportedSlot(slot: unknown): number {
    const n = Number(slot);
    if (!SUPPORTED_SLOTS.includes(n)) throw new ProviderRpcError(ErrorCode.ChainDisconnected, "No Chain Module for that Slot.");
    return n;
  }

  async function route(message: BackgroundMessage, sender: Sender): Promise<unknown> {
    switch (message?.kind) {
      case "provider.request": {
        const origin = host.requester(sender).origin;
        if (origin === undefined) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return handleProviderRequest(origin, message.method, message.params);
      }
      case "approval.get":
        if (!host.requester(sender).walletPage) return null;
        return (await approvals.get(message.id)?.prompt()) ?? null;
      case "approval.resolve":
        if (!host.requester(sender).walletPage) return null;
        approvals.get(message.id)?.settle({ approved: message.approved === true, blindSigning: message.blindSigning === true });
        return null;
      case "approval.unlock": {
        // Unlocking from an approval window: throws (wrong password) without answering the prompt.
        if (!host.requester(sender).walletPage) return null;
        const approval = approvals.get(message.id);
        if (approval === undefined) return null;
        await vault.unlock(String(message.password ?? ""));
        approval.settle({ approved: true });
        return null;
      }
      case "grants.list":
        if (!host.requester(sender).walletPage) return null;
        return (await grants.list()).sort((a, b) => a.origin.localeCompare(b.origin));
      case "grants.revoke":
        if (!host.requester(sender).walletPage) return null;
        if (typeof message.origin === "string") await grants.remove(message.origin);
        return null;
      case "accounts.list":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        // One entry per Slot with a Chain Module; addresses are public, so the page may show them.
        return Promise.all(
          SUPPORTED_SLOTS.map(async (slot) => ({ slot, addresses: await accounts.receiveAddresses(slot) })),
        );
      case "chains.list":
        // Public: what the Chain Entries say, so the page can name chains and assets even while locked.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        // Each names its Chain Entry's assets, then the asset store's.
        return Promise.all(
          (await describeChains()).map(async (c) => ({ ...c, on: c.id === "l1" || (await chainsOn.isOn(c.id)), assets: await assets.named(c.chain) })),
        );
      case "assets.list":
        // The asset store's entries for a Slot's network, for the Assets screen. Public, like `chains.list`.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return assets.list(await slotChain(supportedSlot(message.slot)));
      case "assets.label":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return assets.label(await slotChain(supportedSlot(message.slot)), String(message.asset ?? ""), {
          name: String(message.name ?? ""),
          ticker: String(message.ticker ?? ""),
          precision: Number(message.precision),
        });
      case "assets.remove":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        await assets.remove(await slotChain(supportedSlot(message.slot)), String(message.asset ?? ""));
        return null;
      case "assets.addByContract": {
        // Names an asset by its contract, checked against the chain: answers what was stored.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        const module = await chainModule(await onSlot(message.slot))!;
        const { entry, network } = servedNetwork(module);
        if (network.sidechainServer.api !== "esplora") {
          throw new ProviderRpcError(ErrorCode.InvalidParams, `${entry.name}'s server doesn't say how an asset was issued, so its contract can't be checked.`);
        }
        return assets.addByContract(module, esplora(entry, network), String(message.asset ?? ""), String(message.contract ?? ""));
      }
      case "assets.addByRegistration": {
        // Names a Flush asset from its registration, checked against the chain: answers what was stored.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        const module = await chainModule(await onSlot(message.slot))!;
        const { entry, network } = servedNetwork(module);
        if (network.sidechainServer.api !== "flush") {
          throw new ProviderRpcError(ErrorCode.InvalidParams, `${entry.name}'s server doesn't say which transaction registered an asset.`);
        }
        return assets.addByRegistration(module, esplora(entry, network), String(message.asset ?? ""));
      }
      case "assets.nameFromRegistrations": {
        // Each asset is tried once a session: one that can't be named isn't asked about on every refresh.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
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
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        const slot = supportedSlot(message.slot);
        await settings.setChainOn(await slotChain(slot), message.on === true);
        return null;
      }
      case "settings.unit":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return settings.unit();
      case "settings.setUnit":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        await settings.setUnit(String(message.unit ?? ""));
        return settings.unit();
      case "settings.rereadSeconds":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return settings.rereadSeconds();
      case "settings.setRereadSeconds":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        await settings.setRereadSeconds(Number(message.seconds));
        return settings.rereadSeconds();
      case "view.pinned":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return pinned();
      case "view.setPinned": {
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        const on = message.pinned === true;
        await host.persistent.set(PINNED_KEY, on);
        await host.applyPinned(on);
        return on;
      }
      case "l1.account":
        // eCash's own account: its receive address and what its server reports are asked separately.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return { addresses: await accounts.l1ReceiveAddresses() };
      case "l1.reported":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return byItself(message, () => pullPath.reportedL1State());
      case "l1.cached":
        // The last report this session, shown while `l1.reported` refreshes it; null if none.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return (await pullPath.cachedL1State()) ?? null;
      case "accounts.cached":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return (await pullPath.cachedState(await onSlot(message.slot))) ?? null;
      case "accounts.reported":
        // What a Slot's Sidechain Server reports for the addresses the wallet watches.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        {
          const slot = await onSlot(message.slot);
          return byItself(message, () => pullPath.reportedState(slot));
        }
      case "history.reported":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        {
          const slot = message.slot === undefined ? undefined : await onSlot(message.slot);
          return byItself(message, () => (slot === undefined ? pullPath.l1History() : pullPath.history(slot)));
        }
      case "history.cached":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return (await (message.slot === undefined ? pullPath.cachedL1History() : pullPath.cachedHistory(await onSlot(message.slot)))) ?? null;
      case "send.start":
        // The wallet's own Send: resolves once broadcast, or once a `/v1` server accepted it.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        {
          const slot = await onSlot(message.slot);
          return announcing([slot], sends.send(slot, { outputs: Array.isArray(message.outputs) ? (message.outputs as TransferOutput[]) : [] }, undefined, hostOf(message)));
        }
      case "send.spendable":
        // What a Send on the Slot can spend now, per asset.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return sends.spendable(await onSlot(message.slot));
      case "send.refused":
        // The Slot's last Send that failed after approval, for the Activity feed: its page may be gone.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return (await sends.refused(supportedSlot(message.slot))) ?? null;
      case "send.dismissRefused":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        await sends.dismissRefused(supportedSlot(message.slot));
        return null;
      case "deposit.start":
        // Resolves once the M5 is broadcast (after the user's approval).
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        {
          const slot = await onSlot(message.slot);
          return announcing(["l1", slot], deposits.start(slot, String(message.amount ?? ""), hostOf(message)));
        }
      case "deposit.list":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return byItself(message, () => deposits.list(supportedSlot(message.slot)));
      case "deposit.dismiss":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        await deposits.dismiss(String(message.txid ?? ""));
        return null;
      case "deposit.refused":
        // The Slot's last Deposit that failed after approval, for the home page: its page may be gone.
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        return (await deposits.refused(supportedSlot(message.slot))) ?? null;
      case "deposit.dismissRefused":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
        await deposits.dismissRefused(supportedSlot(message.slot));
        return null;
      case "vault.status":
      case "vault.generate":
      case "vault.create":
      case "vault.unlock":
      case "vault.lock":
      case "vault.setAutoLock":
        if (!host.requester(sender).walletPage) throw new ProviderRpcError(ErrorCode.Unauthorized, "Unknown requester.");
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

  return {
    route,
    toErrorResponse,
    checkAutoLock: () => vault.checkAutoLock(),
    activity: () => vault.touch(),
    connectApprovalHost(name: string, port: ApprovalHost) {
      approvalHosts.set(name, port);
      port.onClose(() => approvalHosts.delete(name));
    },
  };

  function toErrorResponse(error: unknown): ProviderResponse {
    if (error instanceof ProviderRpcError) return { ok: false, error: { code: error.code, message: error.message } };
    if (error instanceof VaultError) return { ok: false, error: { code: VAULT_ERROR, message: error.message } };
    if (error instanceof SidechainServerError) return { ok: false, error: { code: SIDECHAIN_SERVER_ERROR, message: error.message } };
    console.error(error);
    return { ok: false, error: { code: ErrorCode.Internal, message: "Internal wallet error." } };
  }
}
