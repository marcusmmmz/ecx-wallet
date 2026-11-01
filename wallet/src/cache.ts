// What the wallet keeps for the session, mostly to answer faster. Every entry lives in `storage.session`
// (memory only, gone when the browser closes) and is forgotten on lock (the background clears
// every key under CACHE_PREFIX). Nothing a transaction is built from comes from it, except raw
// transactions, which are checked against their txid before they're kept. Two kinds are also kept
// for good in `host.persistent`, under the same keys, which lock doesn't clear: a trade's outcome
// once final (`trade`) and an address's settled history (`addressHistory`).
import type { IdentityBlock } from "./chain-module";
import type { ChainId } from "./spends";
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
  /**
   * What a Flush server's market index said of a trade in a block: its fill, or none (docs/adr/0017).
   * By block, since a soft one can be replaced and the trade mined again elsewhere.
   */
  trade: (url: string, txid: string, blockHash: string) => `${CACHE_PREFIX}trade:${url}:${txid}:${blockHash}`,
  /** An address's settled history, kept for good so the next read pages back only to it (`KeptHistory`). */
  addressHistory: (url: string, address: string) => `${CACHE_PREFIX}address-history:${url}:${address}`,
  /** A raw transaction (hex): it never changes. */
  tx: (txid: string) => `${CACHE_PREFIX}tx:${txid}`,
  /**
   * The Slot's last Deposit that failed after the user approved it. Not for speed: the page that
   * asked may be gone by then (the popup closes when the approval window opens), so the home
   * page shows it instead, until closed or the next Deposit is sent.
   */
  depositRefused: (slot: number) => `${CACHE_PREFIX}deposit-refused:${slot}`,
  /** The chain's (a Slot's, or "l1") last Send that failed after the user approved it, for the same reason. */
  sendRefused: (chain: ChainId) => `${CACHE_PREFIX}send-refused:${chain}`,
};
