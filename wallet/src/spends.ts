// What the wallet's own spends over Esplora share: Send on any chain (send.ts) and Deposit on the
// main chain (deposit.ts). Both gather the account's coins the same way, pay change to the same
// address, and hold back what they spent from the next one.
//
// Coins a broadcast spend took are held until it confirms, or until the server has forgotten it for
// HOLD_BLOCKS blocks: the server may not list the spend in its mempool yet. On the main chain a Send
// and a Deposit share one held list and one queue (#40), so neither picks a coin the other just spent.
import type { EsploraClient, EsploraUtxo } from "./esplora";
import { QUERIES_AT_ONCE } from "./esplora";

/** A chain the wallet spends on: a Slot, or the main chain (eCash itself). */
export type ChainId = number | "l1";

/** Blocks past its broadcast after which a spend the server doesn't know releases its coins. */
export const HOLD_BLOCKS = 6;

/** The coins a broadcast spend took, held back from later ones. */
export interface HeldSpend {
  /** The chain it spent on. Kept as `slot` since stored entries predate the main chain's Send. */
  slot: ChainId;
  txid: string;
  spent: { txid: string; vout: number }[];
  /** The server's tip when it was broadcast. */
  tipHeight: number;
}

/** Where held spends are kept (`storage.local`): they must outlive the session. */
export interface HeldStore {
  list(): Promise<HeldSpend[]>;
  put(held: HeldSpend): Promise<void>;
  remove(txid: string): Promise<void>;
}

/** The chain's held outpoints (`txid:vout`), after releasing those whose spend confirmed or was forgotten long enough. */
export async function heldOutpoints(store: HeldStore, chain: ChainId, server: EsploraClient): Promise<Set<string>> {
  const held = new Set<string>();
  let tip: Promise<number> | undefined;
  for (const spend of (await store.list()).filter((h) => h.slot === chain)) {
    const status = await server.txStatus(spend.txid);
    const forgotten = status === undefined && (await (tip ??= server.tipHeight())) >= spend.tipHeight + HOLD_BLOCKS;
    if (status?.confirmed || forgotten) {
      await store.remove(spend.txid);
      continue;
    }
    for (const { txid, vout } of spend.spent) held.add(`${txid}:${vout}`);
  }
  return held;
}

/** One of the account's addresses: 0 receive, 1 change. */
interface WatchedAddress {
  address: string;
  index: number;
}

/** An output the server lists on one of the account's addresses, and which address that is. */
export type AccountUtxo = EsploraUtxo & { chain: 0 | 1; index: number };

/** What the server lists on each of the account's addresses, QUERIES_AT_ONCE addresses at a time. */
export async function accountUtxos(server: EsploraClient, account: { receive: WatchedAddress[]; change: WatchedAddress[] }): Promise<AccountUtxo[]> {
  const addresses = [...account.receive.map((a) => ({ ...a, chain: 0 as const })), ...account.change.map((a) => ({ ...a, chain: 1 as const }))];
  const found: AccountUtxo[] = [];
  for (let i = 0; i < addresses.length; i += QUERIES_AT_ONCE) {
    const batch = addresses.slice(i, i + QUERIES_AT_ONCE);
    for (const utxos of await Promise.all(batch.map(async ({ address, chain, index }) => (await server.addressUtxos(address)).map((u) => ({ ...u, chain, index }))))) {
      found.push(...utxos);
    }
  }
  return found;
}

/** The first change address nothing has paid yet; the last one once all are used. */
export async function changeIndex(server: EsploraClient, change: WatchedAddress[]): Promise<number> {
  const counts = await Promise.all(change.map(({ address }) => server.addressTxCount(address)));
  const unused = change.find((_, i) => counts[i] === 0);
  return (unused ?? change[change.length - 1]).index;
}

/** Runs each chain's spends one at a time, so two never pick the same coins. */
export function createSpendQueue() {
  /** Each chain's last spend, which the next one waits for. */
  const queues = new Map<ChainId, Promise<unknown>>();
  return function queued<T>(chain: ChainId, run: () => Promise<T>): Promise<T> {
    const result = (queues.get(chain) ?? Promise.resolve()).then(run, run);
    queues.set(chain, result.catch(() => {}));
    return result;
  };
}

export type SpendQueue = ReturnType<typeof createSpendQueue>;
