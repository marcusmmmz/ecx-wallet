// The pull path's seam to a Slot's Sidechain Server, whichever Server API its Chain Entry names
// (docs/adr/0002): the Standard Sidechain API (standard-sidechain-api.ts) or Esplora (esplora.ts);
// server-api.ts picks the client.
// Everything a server answers is *reported*: the wallet shows balances labelled as such, and treats
// a built transfer as an untrusted Signing Request (parsed, validated and decoded like any other).
import type { AssetAmount, DerivedAddress, TransferOutput } from "./chain-module";

/** What the wallet watches: watch data from the Chain Module (never spend authority). */
export interface WatchData {
  chain: string;
  descriptor: string;
  receive: DerivedAddress[];
  change: DerivedAddress[];
}

/** A server's account of a watch. Unverified by the wallet. */
export interface ReportedState {
  /** Confirmed and spendable, less what the server's mempool already spends. */
  balances: AssetAmount[];
  /** What unconfirmed outputs would add once confirmed, per asset; none if nothing is pending. */
  unconfirmed: AssetAmount[];
  /**
   * Tokens only the server vouches for, beyond `balances` and `unconfirmed`: those on Flush's
   * result outputs, whose token no transaction states (docs/adr/0013). Absent if none.
   */
  unverified?: AssetAmount[];
  /**
   * The part of `balances` in blocks no eCash anchor covers yet (Flush's `soft`, docs/adr/0012):
   * counted and spendable, but an anchor may still replace them. Absent if none.
   */
  preconfirmed?: AssetAmount[];
  /**
   * When the chain's last block was mined (seconds since the epoch), if it's been longer than the
   * chain ever goes without one: nothing confirms until it moves again. Flush only (docs/adr/0012).
   */
  stalledSince?: number;
}

/** A transaction touching a watch, as its server reports it. Unverified by the wallet. */
export interface HistoryEntry {
  txid: string;
  /** The watch's net change per asset: base units, negative for what left it. */
  amounts: AssetAmount[];
  confirmed: boolean;
  /** Confirmed in a Flush block no eCash anchor covers yet (`soft`, docs/adr/0012). */
  preconfirmed?: true;
  /** When its block was mined, in seconds since the epoch; only once confirmed. */
  time?: number;
  /**
   * Unconfirmed only: it spends only the wallet's own coins, each confirmed or from a trusted
   * transaction (Bitcoin Core's `IsTrusted`), so only the wallet could replace it.
   */
  trusted?: boolean;
  /** It spends the wallet's coins and pays only the wallet back: all it cost is the fee. */
  toSelf?: boolean;
  /** Some of the wallet's outputs it pays or spends are confidential: their amounts aren't in `amounts`. */
  hidden?: boolean;
  /**
   * It pays or spends a result output of the wallet's (Flush, docs/adr/0013): what that carries is
   * in the node's state, not the transaction, so it isn't in `amounts`.
   */
  results?: true;
  /** A Flush trade through one pool the wallet made, with its outcome (docs/adr/0017). */
  trade?: TradeEntry;
  /** The wallet's M5 to this Slot's Treasury (eCash only). */
  depositTo?: number;
  /** A Deposit's credit on a Slot (an input claims the Deposit): the Deposit's parent-chain txid. */
  depositFrom?: string;
  /** An input of the wallet's issues an asset (Elements): a new one, or more of one it has the token for. */
  issuance?: Issuance;
}

/**
 * A Flush trade (kind 21) the wallet funded, paying ECX to one of its addresses. Its entry is the
 * trade's, with the coinbase outputs that paid it folded in: `amounts` nets them, and a coinbase
 * that paid only it is left out (docs/adr/0017, 0018).
 */
export interface TradeEntry {
  /** The pools it trades through, in order. */
  pools: string[];
  /** What it paid in: its order's asset and amount. */
  given: AssetAmount;
  /** The ECX fee, base units. */
  fee: string;
  outcome: TradeOutcome;
}

/**
 * - `settling`: not in a block yet, or the market index hasn't reached its block.
 * - `unknown`: the market index couldn't be read (`error`).
 * - `filled`: what came out (`back`), as the market index reports it.
 * - `missed`: what it paid in comes back (`back`), on its result or, for ECX, by coinbase.
 *
 * `payout`, when ECX comes back: the coinbase that paid it, or `queued` while none has. `returned`:
 * a launch buy's ECX past the curve's end, paid the same way.
 */
export type TradeOutcome =
  | { state: "settling" }
  | { state: "unknown"; error: string }
  | { state: "filled" | "missed"; back: AssetAmount; payout?: TradePayout | "queued"; returned?: { amount: string; payout: TradePayout | "queued" } };

/** The coinbase output that paid a trade's ECX. */
export interface TradePayout {
  txid: string;
  /** Its block's time, in seconds since the epoch. */
  time?: number;
}

/** What an Elements input issues: a new asset, or more of one through its reissuance token. */
export type Issuance = "new" | "reissuance";

/** A Slot's Treasury script on eCash, by which a server's client recognizes the wallet's Deposits. */
export interface TreasuryScript {
  slot: number;
  scriptPubkey: string;
}

/** A server's account of a watch's transactions, newest first. */
export interface ReportedHistory {
  entries: HistoryEntry[];
  /** The server has older transactions it didn't list. */
  partial: boolean;
}

/** A Send: one or more payments, in order. Addresses are in the chain's own encoding. */
export interface TransferOrder {
  outputs: TransferOutput[];
}

/** The server couldn't be reached or refused a call. */
export class SidechainServerError extends Error {
  constructor(
    readonly server: string,
    message: string,
    /** The server's error code, when it gave one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "SidechainServerError";
  }
}

export interface SidechainServer {
  /** The server's base URL: who the wallet names as the requester of what it builds. */
  readonly url: string;
  state(watch: WatchData): Promise<ReportedState>;
  /**
   * The transactions touching the watch, newest first: the latest ones only, never paged. On eCash,
   * `treasuries` are the Slots' Treasury scripts, to label Deposits.
   */
  history(watch: WatchData, treasuries?: TreasuryScript[]): Promise<ReportedHistory>;
  /** Asks the server to build a transfer; returns its Signing Request (unvalidated). */
  buildTransfer(watch: WatchData, order: TransferOrder): Promise<unknown>;
  /** Hands the signed payload back for the server to finalize and broadcast. */
  submit(watch: WatchData, requestId: string, payload: string): Promise<{ accepted: boolean; txid?: string }>;
}

export type Fetch = typeof fetch;

/** `fetch` for a server call: never sends credentials or reads a cache; unreachable → SidechainServerError. */
export async function serverFetch(fetchFn: Fetch, url: string, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchFn(`${url}${path}`, { ...init, credentials: "omit", cache: "no-store" });
  } catch {
    throw new SidechainServerError(url, `Couldn't reach the Sidechain Server at ${url}.`);
  }
}

export function isAssetAmount(a: unknown): a is AssetAmount {
  const { asset, amount } = (a ?? {}) as Record<string, unknown>;
  return typeof asset === "string" && /^[0-9a-f]{64}$/.test(asset) && typeof amount === "string" && /^[0-9]+$/.test(amount);
}
