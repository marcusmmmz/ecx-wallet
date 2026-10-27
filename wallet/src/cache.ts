// What the wallet keeps for the session, mostly to answer faster. Every entry lives in `storage.session`
// (memory only, gone when the browser closes) and is forgotten on lock (the background clears
// every key under CACHE_PREFIX). Nothing a transaction is built from comes from it, except raw
// transactions, which are checked against their txid before they're kept.
import type { IdentityBlock } from "./chain-module";
import type { KeyValueStore } from "./vault";

export const CACHE_PREFIX = "cache:";

export type SessionCache = Pick<KeyValueStore, "get" | "set">;

export const cacheKey = {
  /** A server that passed the identity check for this block (ADR 0002: once per URL). */
  identity: (url: string, { height, hash }: IdentityBlock) => `${CACHE_PREFIX}identity:${url}:${height}:${hash}`,
  /** The last balance a chain's server reported, for display while it refreshes. */
  balance: (chain: string, url: string) => `${CACHE_PREFIX}balance:${chain}:${url}`,
  /** The last history a chain's server reported, for display while it refreshes. */
  history: (chain: string, url: string) => `${CACHE_PREFIX}history:${chain}:${url}`,
  /** What a Flush server's market index said of a trade: its fill, or none (docs/adr/0017). */
  trade: (url: string, txid: string) => `${CACHE_PREFIX}trade:${url}:${txid}`,
  /** A raw transaction (hex): it never changes. */
  tx: (txid: string) => `${CACHE_PREFIX}tx:${txid}`,
  /**
   * The Slot's last Deposit that failed after the user approved it. Not for speed: the page that
   * asked may be gone by then (the popup closes when the approval window opens), so the home
   * page shows it instead, until closed or the next Deposit is sent.
   */
  depositRefused: (slot: number) => `${CACHE_PREFIX}deposit-refused:${slot}`,
  /** The Slot's last Send that failed after the user approved it, for the same reason. */
  sendRefused: (slot: number) => `${CACHE_PREFIX}send-refused:${slot}`,
};
