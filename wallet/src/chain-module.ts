// Typed access to a Chain Module's .wasm (elements.wasm for Slot 24, l1.wasm for eCash itself).
// The shape follows the spec's Chain Module interface. A module returns data only and holds
// nothing: it gets its key per call, a Slot's Starter or, for eCash, the L1 Account Key. Beyond
// the interface, a Slot's module may declare `depositDestination`, and the L1 module builds Deposits.
import { CoreModule, CoreModuleError } from "./wasm";

declare const keyKind: unique symbol;
/** A Slot's Starter, as the Vault hands it out. Only that Slot's Chain Module gets it. */
export type Starter = string & { readonly [keyKind]: "Starter" };
/** The L1 Account Key, `[fingerprint/84h/0h/0h]xprv…`. Only the L1 Chain Module gets it. */
export type L1AccountKey = string & { readonly [keyKind]: "L1AccountKey" };
/** The key a Chain Module derives from: which one is set by its place in the tree (docs/adr/0003). */
export type ChainKey = Starter | L1AccountKey;

/** What a module serves: Signing Requests for `chain` in `format`. */
export interface Binding {
  /** CAIP-2 in our own namespace, e.g. `ecash:betanet-s24`. */
  chain: string;
  format: string;
  payloadVersions: string[];
}

export interface Declaration {
  binding: Binding;
  /** Optional capabilities: `depositDestination`, `buildTransfer` and `assetContract` (a Slot's), `buildDeposit` (L1's). */
  capabilities: string[];
}

/** The protocol the wallet speaks to a Sidechain Server (docs/adr/0002). */
export type ServerApi = "ecx-v0" | "esplora";

/** A network's default Sidechain Server: where it is and which Server API it speaks. */
export interface SidechainServerEntry {
  api: ServerApi;
  url: string;
}

/** A block by height and hash (display hex): a server must have it to be on the chain. */
export interface IdentityBlock {
  height: number;
  hash: string;
}

/** One network of a chain, as its Chain Entry describes it. `params` are the module's own. */
export interface NetworkEntry<P = unknown> {
  /** CAIP-2: `ecash:<network>` for the root, `ecash:<network>-s<slot>` under it. */
  chain: string;
  /** The parent chain's `chain`; absent for the root (eCash). */
  parent?: string;
  /** Height 0 and the genesis, or for a fork the first block after it (docs/adr/0003). */
  identityBlock: IdentityBlock;
  /**
   * The parent-chain block whose M2 activated the Slot, pinned once checked; only under a parent.
   * Without it, a Deposit to a Slot with no Treasury yet is refused (docs/adr/0004).
   */
  activation?: IdentityBlock;
  /** Parent-chain confirmations before the Slot credits a Deposit; only under a parent. Absent, BIP300's 100. */
  depositConfirmations?: number;
  /** Default Sidechain Server. */
  sidechainServer: SidechainServerEntry;
  /** Official App origins. */
  officialApps: string[];
  /** The assets the wallet names on this network; any other shows as an unknown asset. */
  assets: AssetEntry[];
  params: P;
}

/** An asset the wallet shows by name (docs/adr/0005). */
export interface AssetEntry {
  /** Lowercase display hex; `NATIVE_COIN` for the root's coin. */
  id: string;
  ticker: string;
  name: string;
  /** Places after the point in one whole unit; amounts are reported in base units. */
  decimals: number;
  /** The network's ECX, which the wallet adds up across chains. At most one per network. */
  ecx?: boolean;
}

/**
 * The description of one chain of the tree, eCash itself or a sidechain, that ships with its Chain
 * Module. The root has neither `slot` nor `parent`; every other chain has both (docs/adr/0003).
 */
export interface ChainEntry<P = unknown> {
  /** The chain's Slot under its parent; absent for the root. */
  slot?: number;
  /** The name the wallet shows ("Main chain", "Elements+"). */
  name: string;
  /** One line on what the chain is for. */
  description: string;
  networks: Record<string, NetworkEntry<P>>;
}

/** Elements' own per-network values (`core/elements/src/chain_entry.rs`). */
export interface ElementsParams {
  genesisHash: string;
  parentGenesisHash: string;
  policyAsset: string;
  addressParams: { p2pkhPrefix: number; p2shPrefix: number; blindedPrefix: number; bechHrp: string; blechHrp: string };
  /** The parent (L1) chain's address encoding, for a Withdrawal's L1 destination. */
  parentAddressParams: { p2pkhPrefix: number; p2shPrefix: number; bechHrp: string };
}

export interface DerivedAddress {
  index: number;
  /** In the chain's own encoding (`elements1…` for Slot 24). */
  address: string;
  scriptPubkey: string;
  /** The key the script pays: 33-byte compressed, hex. */
  publicKey: string;
}

/** Addresses and the watch data a Sidechain Server needs. */
export interface Account {
  descriptor: string;
  receive: DerivedAddress[];
  change: DerivedAddress[];
}

/** `AssetAmount.asset` on a chain without assets (eCash): its only coin, in sats. */
export const NATIVE_COIN = "";

export interface AssetAmount {
  /** Display hex, or NATIVE_COIN on a chain without assets. */
  asset: string;
  /** Base units, as a decimal string (negative only in `totalLeaving`, where it means coming in). */
  amount: string;
}

/** What a module can prove about a request without understanding it. */
export interface VerifiableFacts {
  /** Inputs that re-derive to the Starter's keys: the only ones `sign` signs. */
  ownedInputs: (AssetAmount & { index: number })[];
  /**
   * Per asset: owned inputs minus outputs back to the wallet. Negative means more comes into the
   * wallet than leaves it, as with an asset the request issues to the wallet; the approval window
   * lists those as "Coming into your wallet" without the sign.
   */
  totalLeaving: AssetAmount[];
  fee: AssetAmount[];
  /** PSET fields the module doesn't know (kept byte-for-byte when signing). */
  unknownFields: string[];
  /** Risky modes, shown above everything else. */
  dangerousFlags: string[];
}

/** Where an output's funds go. `yours` is decided by re-deriving, never by the requester. */
export type Destination =
  | { kind: "address"; address: string; yours: boolean }
  /**
   * A Deposit (an M5, on L1) of `deposit` sats to `slot`, whose Treasury grows from
   * `treasuryBefore` ("0" for its first). `data` (hex; `text` if printable UTF-8) is what the Slot
   * credits it to. The L1 module decodes these; the wallet adds the rest (`credit`) by asking the
   * Slot's own Chain Module.
   */
  | {
      kind: "deposit";
      slot: number;
      deposit: string;
      treasuryBefore: string;
      dataOutput: number;
      data: string;
      text?: string;
      credit?: DepositCredit;
    }
  /**
   * A withdrawal burn (how a Withdrawal starts): `payout` (the burn minus `parentFee`) may be paid
   * on L1 to `l1ScriptPubkey` (hex), which `l1Address` gives as an L1 address if it is standard.
   */
  | { kind: "withdrawal"; l1Address?: string; l1ScriptPubkey: string; payout: string; parentFee: string };

/** What a Deposit is credited to on its Slot, as that Slot's own Chain Module derives it. */
export interface DepositCredit {
  /** CAIP-2 of the Slot's chain. */
  chain: string;
  chainName: string;
  /** In the chain's own encoding. */
  address: string;
  /** The destination re-derives from the Slot's Starter. */
  yours: boolean;
  /** L1 confirmations before the Slot may credit it. */
  confirmations: number;
}

/** A risky mode of a request, shown above everything else. */
export type DangerousMode =
  | { kind: "nonDefaultSighash"; input: number; sighash: number }
  | { kind: "withdrawalBurn"; output: number }
  /** A Deposit: the funds come back to L1 only through a Withdrawal. */
  | { kind: "deposit"; output: number }
  /** A Deposit that spends no Treasury: the wallet can't confirm the Slot is active and empty. */
  | { kind: "firstDeposit"; output: number };

/**
 * A new asset an input issues, its ids derived by the Decoder. Amounts in base units: the precision
 * is in the contract, which the module sees only if the request's evidence supplies it.
 */
export interface ClearIssuance {
  asset: AssetAmount;
  /** The reissuance token, if any. Explicit, so it can never reissue (docs/adr/0008). */
  token?: AssetAmount;
  /** The committed contract's hash, display hex, if any. */
  contractHash?: string;
  /** The contract, if the request's evidence supplied it and it checked out (docs/adr/0009). */
  contract?: ClearContract;
}

/** A contract that hashes to the committed hash and follows the registry's rules. The issuer chose it. */
export interface ClearContract {
  name: string;
  ticker: string;
  precision: number;
  /** Claimed, not checked by this wallet. */
  domain: string;
  /** The issuer key is the key of the address this wallet gives out. */
  issuerYours: boolean;
}

/** What a request the Decoder fully understands does. Data only: `app` renders it. */
export interface ClearView {
  dangerousModes: DangerousMode[];
  /** `treasury`: the Slot whose Treasury the input spends (L1 only). `issuance`: Elements only. */
  inputs: (AssetAmount & { index: number; yours: boolean; treasury?: number; issuance?: ClearIssuance })[];
  /** Every output except the fee. */
  outputs: (AssetAmount & { index: number; destination: Destination })[];
  fee: AssetAmount;
}

/** `decode`'s answer for a request it doesn't refuse: a Clear View only if fully understood. */
export type Decoded =
  | { kind: "clear"; view: ClearView }
  | { kind: "blind"; reason: string; verifiableFacts: VerifiableFacts };

/** Which rule a module refused a request by. */
export type RefusalCode =
  | "malformed"
  | "wrongGenesis"
  | "confidential"
  | "missingInputFields"
  /** No input in the request is the Starter's: signing would change nothing. */
  | "nothingToSign"
  /** The request's evidence doesn't check out against the payload (docs/adr/0009). */
  | "invalidEvidence"
  /** `assetContract`: the contract isn't the asset's, or breaks the registry's rules (docs/adr/0010). */
  | "invalidContract"
  | "invalidStarter"
  /** L1: the spend isn't replay-marked (docs/adr/0004). */
  | "noReplayMarker"
  | "invalidAccountKey"
  /** `buildDeposit`, `buildTransfer`: the coins don't cover the amounts and the fee. */
  | "insufficientFunds"
  /** `buildTransfer`: an amount, or change that can't go to the fee, is below what the chain relays. */
  | "dust";

/** A module refused to decode or sign a request. */
export class ChainModuleRefusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "ChainModuleRefusal";
  }
}

/** A contract `assetContract` checked: the one the asset was issued with, following the registry's rules. The issuer chose it. */
export interface CheckedContract {
  /** Display hex. */
  asset: string;
  name: string;
  ticker: string;
  precision: number;
  /** Claimed, not checked by this wallet. */
  domain: string;
}

/** A Slot's `depositDestination`: what a Deposit to it is credited to, and its rules. */
export interface DepositDestination {
  /** In the chain's own encoding. */
  address: string;
  /** The bytes an M5's `OP_RETURN` carries, hex. */
  destination: string;
  /** The asset the credit arrives in (display hex). */
  asset: string;
  /** Sats: the smallest Deposit. */
  minimum: string;
}

/** A Chain Module whose key is `K`. */
export interface ChainModule<K extends ChainKey = Starter> {
  declare(): Declaration;
  chainEntry(): ChainEntry;
  /** The module's key → its account, with the first `receive` receive and `change` (default 0) change addresses. */
  deriveAccount(key: K, options: { receive: number; change?: number }): Account;
  /** Refuses (throws ChainModuleRefusal) what the module would refuse anyway, without the key. */
  check(payload: string): void;
  /** A request's payload → a Clear View or Blind. Throws ChainModuleRefusal. */
  /** `evidence`: the Signing Request's, as the requester sent it; a module ignores kinds it doesn't know. */
  decode(payload: string, key: K, evidence?: unknown): Decoded;
  /** The payload with signatures on the inputs the key owns; nothing else changes. Throws ChainModuleRefusal. */
  sign(payload: string, key: K): string;
  /** Only if `declare()` lists `depositDestination` (throws otherwise). */
  depositDestination(key: K): DepositDestination;
  /**
   * Only if `declare()` lists `buildTransfer`: an unsigned transfer (base64) and the coins it
   * spends. Throws ChainModuleRefusal (`insufficientFunds`, `dust`, `confidential`, …).
   */
  buildTransfer(order: ModuleTransferOrder, key: K): BuiltTransfer;
  /** A signed payload → the raw transaction (hex) and its txid. Throws ChainModuleRefusal. */
  finalize(payload: string): { tx: string; txid: string };
  /**
   * Only if `declare()` lists `assetContract`: `contract` (its exact JSON), if it is the one `asset`
   * was issued with by a new issuance spending `issuance` (display hex txid). Needs no key. Throws
   * ChainModuleRefusal (`invalidContract`).
   */
  assetContract(asset: string, issuance: { txid: string; vout: number }, contract: string): CheckedContract;
}

/** What to send, and what to build it from (a Chain Module's `TransferOrder`). */
export interface ModuleTransferOrder {
  /** The account's explicit coins to choose from: confirmed or trusted, none held back. */
  coins: { txid: string; vout: number; asset: string; value: string; chain: 0 | 1; index: number }[];
  outputs: TransferOutput[];
  /** Sats per 1000 vbytes. */
  feeRate: number;
  changeIndex: number;
}

/** One payment of a transfer. `to` is tagged so scripts and data can join addresses later. */
export interface TransferOutput {
  /** Hex asset id. */
  asset: string;
  /** Base units, as a decimal string. */
  amount: string;
  to: { address: string };
}

/** A transfer `buildTransfer` built. */
export interface BuiltTransfer {
  /** Base64, unsigned. */
  pset: string;
  /** The coins it spends. */
  spent: { txid: string; vout: number }[];
}

/** What to deposit, and what to build it from (the L1 module's `DepositOrder`). */
export interface DepositOrder {
  slot: number;
  /** Sats, as a decimal string. */
  amount: string;
  /** Hex: the Slot's `depositDestination`. */
  destination: string;
  /** Sats per 1000 vbytes. */
  feeRate: number;
  /** Whole transactions (hex), and which of the account's addresses each output pays. */
  coins: { tx: string; vout: number; chain: 0 | 1; index: number }[];
  /** The Slot's Treasury, or null for its first Deposit. */
  treasury: { tx: string; vout: number } | null;
  changeIndex: number;
}

/** eCash's own module: a Chain Module that also builds and completes L1 transactions. */
export interface L1Module extends ChainModule<L1AccountKey> {
  /** The Slot's Treasury script on this network, hex. */
  treasuryScript(slot: number): string;
  /** A raw transaction's (hex) txid. Throws CoreModuleError if it isn't one. */
  txid(tx: string): string;
  /** An unsigned M5 (base64 PSBT). Throws ChainModuleRefusal (e.g. `insufficientFunds`). */
  buildDeposit(order: DepositOrder, key: L1AccountKey): string;
}

/** Turns a module's JSON error result into a ChainModuleRefusal. */
function refusals<T>(call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof CoreModuleError) {
      let refusal: { code?: RefusalCode; message?: string } | undefined;
      try {
        refusal = JSON.parse(error.message);
      } catch {
        // Not a refusal (e.g. a UTF-8 error); rethrown below.
      }
      if (refusal?.code !== undefined) throw new ChainModuleRefusal(refusal.code, refusal.message ?? refusal.code);
    }
    throw error;
  }
}

export async function loadChainModule<K extends ChainKey = Starter>(bytes: BufferSource): Promise<ChainModule<K>> {
  return chainModuleOf<K>(await CoreModule.instantiate(bytes));
}

function chainModuleOf<K extends ChainKey>(m: CoreModule): ChainModule<K> {
  const json = <T>(name: string, ...args: (string | number)[]) => JSON.parse(m.callText(name, ...args)) as T;
  return {
    declare: () => json<Declaration>("declare"),
    chainEntry: () => json<ChainEntry>("chain_entry"),
    deriveAccount: (key, { receive, change = 0 }) => json<Account>("derive_account", key, receive, change),
    check: (payload) => refusals(() => void m.callText("check", payload)),
    decode: (payload, key, evidence) => refusals(() => json<Decoded>("decode", payload, key, JSON.stringify(evidence ?? {}))),
    sign: (payload, key) => refusals(() => m.callText("sign", payload, key)),
    depositDestination: (key) => json<DepositDestination>("deposit_destination", key),
    buildTransfer: (order, key) => refusals(() => json<BuiltTransfer>("build_transfer", JSON.stringify(order), key)),
    finalize: (payload) => refusals(() => json<{ tx: string; txid: string }>("finalize", payload)),
    assetContract: (asset, { txid, vout }, contract) => refusals(() => json<CheckedContract>("asset_contract", asset, txid, vout, contract)),
  };
}

export async function loadL1Module(bytes: BufferSource): Promise<L1Module> {
  const m = await CoreModule.instantiate(bytes);
  const module = chainModuleOf<L1AccountKey>(m);
  const json = <T>(name: string, ...args: (string | number)[]) => JSON.parse(m.callText(name, ...args)) as T;
  return {
    ...module,
    treasuryScript: (slot) => m.callText("treasury_script", slot),
    txid: (tx) => m.callText("txid", tx),
    buildDeposit: (order, key) => refusals(() => json<{ psbt: string }>("build_deposit", JSON.stringify(order), key).psbt),
  };
}
