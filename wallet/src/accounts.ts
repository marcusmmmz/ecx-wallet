// Accounts: which Chain Module serves a chain, and the addresses it derives. Routing rule (spec
// #18, story 44; docs/adr/0003): a module only ever receives the key its chain's place in the tree
// calls for. eCash (the root) gets the L1 Account Key; a Slot under it gets that Slot's Starter.
import {
  type AssetEntry,
  loadChainModule,
  loadL1Module,
  type ChainEntry,
  type ChainKey,
  type ChainModule,
  type L1AccountKey,
  type L1Module,
  type NetworkEntry,
  type Starter,
} from "./chain-module";

/** Slots with a bundled Chain Module, and the .wasm each ships as. */
export const CHAIN_MODULE_FILES: Readonly<Record<number, string>> = { 24: "elements.wasm" };

export const SUPPORTED_SLOTS: readonly number[] = Object.keys(CHAIN_MODULE_FILES).map(Number);

/** eCash's own Chain Module, the root of the tree. */
export const L1_MODULE_FILE = "l1.wasm";

/** Instantiates `file`'s module on first use, and again if that failed. */
function lazily<T>(load: () => Promise<T>): () => Promise<T> {
  let module: Promise<T> | undefined;
  return () => {
    module ??= load();
    module.catch(() => (module = undefined));
    return module;
  };
}

/**
 * Lazily instantiates each Slot's Chain Module, once, in its own WASM instance. `fetchWasm` gets a
 * shipped file's bytes (the background fetches it from the extension package).
 */
export function createChainModules(fetchWasm: (file: string) => Promise<BufferSource>) {
  const loaders = new Map(
    Object.entries(CHAIN_MODULE_FILES).map(([slot, file]) => [Number(slot), lazily(() => fetchWasm(file).then((b) => loadChainModule<Starter>(b)))]),
  );
  return function chainModule(slot: number): Promise<ChainModule<Starter>> | undefined {
    return loaders.get(slot)?.();
  };
}

/** eCash's Chain Module, lazily instantiated once in its own WASM instance. */
export function createL1Module(fetchWasm: (file: string) => Promise<BufferSource>): () => Promise<L1Module> {
  return lazily(() => fetchWasm(L1_MODULE_FILE).then(loadL1Module));
}

/** An address as the Provider and the account screen give it out. */
export interface SlotAddress {
  /** CAIP-2, e.g. `ecash:betanet-s24`. */
  chain: string;
  /** In the chain's own encoding. */
  address: string;
  /** The key the address pays: 33-byte compressed, hex. */
  publicKey: string;
}

/** The module's Chain Entry and the network in it the module serves. */
export function servedNetwork(module: ChainModule<never>): { entry: ChainEntry; network: NetworkEntry; chain: string } {
  const { chain } = module.declare().binding;
  const entry = module.chainEntry();
  const network = Object.values(entry.networks).find((n) => n.chain === chain);
  if (network === undefined) throw new Error(`${entry.name}'s Chain Entry has no network for ${chain}.`);
  return { entry, network, chain };
}

/** How the wallet shows a chain: what its Chain Entry says about the network its module serves. */
export interface ChainDescription {
  name: string;
  description: string;
  /** CAIP-2. */
  chain: string;
  /** The network's key in the Chain Entry ("betanet"). */
  network: string;
  assets: AssetEntry[];
  /** The wallet can Send on it (a sidechain whose server builds transfers, or whose module does over Esplora). */
  sends: boolean;
}

export function describeChain(module: ChainModule<never>): ChainDescription {
  const { entry, network, chain } = servedNetwork(module);
  const key = Object.keys(entry.networks).find((k) => entry.networks[k] === network)!;
  const sends = network.parent !== undefined && canSend(module.declare().capabilities, network);
  return { name: entry.name, description: entry.description, chain, network: key, assets: network.assets, sends };
}

/** True if a sidechain can Send through this wallet: its server builds, or its module does over Esplora. */
export function canSend(capabilities: string[], network: NetworkEntry): boolean {
  const { api } = network.sidechainServer;
  return api === "ecx-v0" || (api === "esplora" && capabilities.includes("buildTransfer"));
}

/** Throws unless the entry puts the chain at the root: no Slot and no parent. */
export function assertRoot(entry: ChainEntry, network: NetworkEntry): void {
  if (entry.slot !== undefined || network.parent !== undefined) {
    throw new Error(`${network.chain} isn't the root chain, so it can't get the L1 Account Key.`);
  }
}

/**
 * Throws unless the entry puts the chain at `slot` directly under the root `root`. A chain nested
 * deeper has no key derivation yet: Starters are keyed by the Slot alone (docs/adr/0003).
 */
export function assertChildOfRoot(entry: ChainEntry, network: NetworkEntry, slot: number, root: string): void {
  if (entry.slot !== slot || network.parent === undefined) {
    throw new Error(`${network.chain}'s Chain Entry doesn't describe a chain at Slot ${slot}.`);
  }
  if (network.parent !== root) {
    throw new Error(`${network.chain} sits under ${network.parent}, not under ${root}: the wallet has no keys for nested chains yet.`);
  }
}

/** The Slot's Chain Module and the chain it serves; throws if the wallet has none for the Slot. */
export async function slotChainModule(
  chainModule: (slot: number) => Promise<ChainModule<Starter>> | undefined,
  slot: number,
): Promise<{ module: ChainModule<Starter>; chain: string }> {
  const pending = chainModule(slot);
  if (pending === undefined) throw new Error(`No Chain Module for Slot ${slot}.`);
  const module = await pending;
  return { module, chain: module.declare().binding.chain };
}

/** The keys the Vault hands out, each only to the module the tree routes it to. */
export interface Keys {
  /** The Slot's Starter; throws while the wallet is locked. */
  starter(slot: number): Promise<Starter>;
  /** The L1 Account Key; throws while the wallet is locked. */
  l1AccountKey(): Promise<L1AccountKey>;
}

export interface ChainModules {
  chainModule(slot: number): Promise<ChainModule<Starter>> | undefined;
  l1Module(): Promise<L1Module>;
}

/** A chain's module, the network it serves, and its key, fetched only when needed. */
export interface KeyedChain<K extends ChainKey, M extends ChainModule<K> = ChainModule<K>> {
  module: M;
  entry: ChainEntry;
  network: NetworkEntry;
  chain: string;
  key(): Promise<K>;
}

/** Resolves chains and routes keys by their place in the tree, as the entries describe it. */
export function createKeyRouting(deps: Keys & ChainModules) {
  return {
    /** eCash: the root, which gets the L1 Account Key. */
    async l1(): Promise<KeyedChain<L1AccountKey, L1Module>> {
      const module = await deps.l1Module();
      const { entry, network, chain } = servedNetwork(module);
      assertRoot(entry, network);
      return { module, entry, network, chain, key: () => deps.l1AccountKey() };
    },

    /** A Slot directly under eCash, which gets its own Starter. */
    async slot(slot: number): Promise<KeyedChain<Starter>> {
      const { module } = await slotChainModule(deps.chainModule, slot);
      const { entry, network, chain } = servedNetwork(module);
      const root = servedNetwork(await deps.l1Module()).chain;
      assertChildOfRoot(entry, network, slot, root);
      return { module, entry, network, chain, key: () => deps.starter(slot) };
    },
  };
}

export type KeyRouting = ReturnType<typeof createKeyRouting>;

/**
 * How many receive addresses, from index 0, the wallet gives out. Must equal the Elements module's
 * `APP_RECEIVE_ADDRESSES`: a request may spend those without a `bip32_derivation` entry (docs/adr/0007).
 */
export const APP_RECEIVE_ADDRESSES = 1;

/** The receive address(es) a chain's module derives from its key alone. */
async function receive<K extends ChainKey>({ module, chain, key }: KeyedChain<K>): Promise<SlotAddress[]> {
  const account = module.deriveAccount(await key(), { receive: APP_RECEIVE_ADDRESSES });
  return account.receive.map(({ address, publicKey }) => ({ chain, address, publicKey }));
}

export function createAccounts(deps: Keys & ChainModules) {
  const routing = createKeyRouting(deps);
  return {
    /** The Slot's receive address(es), derived by its Chain Module from its Starter alone. */
    receiveAddresses: async (slot: number): Promise<SlotAddress[]> => receive(await routing.slot(slot)),
    /** The eCash receive address(es), derived by the L1 module from the L1 Account Key alone. */
    l1ReceiveAddresses: async (): Promise<SlotAddress[]> => receive(await routing.l1()),
  };
}

export type Accounts = ReturnType<typeof createAccounts>;
