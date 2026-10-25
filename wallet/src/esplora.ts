// The wallet's client for a Sidechain Server that speaks Esplora (docs/adr/0002): the REST API of
// Blockstream's electrs, limited to the endpoints mempool's electrs fork also serves. Esplora knows
// nothing of watches: the wallet asks for each watched address's outputs and adds them up itself.
// Flush's explorer (Server API `flush`, docs/adr/0012) is mempool's fork plus `/flush/blocks`: a
// block there counts as confirmed only once an eCash anchor covers it. Its tokens ride on outputs
// of value 0, which only the creating transaction's marker explains (docs/adr/0013).
//
// `esploraClient` is the API itself, endpoint by endpoint, each answer checked for shape (Deposit
// uses it directly on eCash's server); `esploraServer` is the pull path's view of it.
import { cacheKey, type SessionCache } from "./cache";
import { NATIVE_COIN, type AssetAmount, type IdentityBlock, type OutputToken, type OutputTokens } from "./chain-module";
import { serverFetch, SidechainServerError, type Fetch, type HistoryEntry, type Issuance, type SidechainServer, type TreasuryScript, type WatchData } from "./sidechain-server";
import { isM5 } from "./treasury";

/**
 * How many address queries run at once: 40 addresses in two rounds. esplora.beta answered 20 at
 * once in about the time of 8, and slowed down sharply at 40 (measured 2026-10-20).
 */
export const QUERIES_AT_ONCE = 20;

/** How many of an address's transactions Esplora lists at once: its mempool's, then its confirmed ones. */
const LISTED_MEMPOOL_TXS = 50;
export const LISTED_CONFIRMED_TXS = 25;

/** The fee rate's confirmation target, in blocks. */
const FEE_TARGET = "6";
/** sat/vB when the server has no estimate for the target. */
const FALLBACK_FEE_RATE = 1;
/** sat/vB the rate never goes below (besides the server's own 1008-block floor). */
const MIN_FEE_RATE = 0.1;

/** How many older pages of an address's confirmed transactions the history reads, past the first. */
export const HISTORY_PAGES = 3;

/**
 * How settled a block is on Flush, as `/flush/blocks` reports it: `soft` until an eCash anchor
 * covers it (another anchor can replace any number of soft blocks), `anchored` by one, `final` by 3.
 */
export type Finality = "soft" | "anchored" | "final";
const FINALITIES: readonly Finality[] = ["soft", "anchored", "final"];

/**
 * The finality at which the wallet counts a Flush block as confirmed. Provisional: whether wallets
 * should wait for `final` was asked of Flush's developer on 2026-10-25 (#56).
 */
export const CONFIRMED_AT: Finality = "anchored";

/** Block hashes `/flush/blocks` takes at once. */
const FINALITY_BATCH = 30;

/**
 * Seconds without a block after which Flush counts as stalled: 20 of its 15-second slots. Its own
 * `getposinfo.stalled` stayed false through a real halt (#55), so the tip's age is the signal.
 */
export const FLUSH_STALL_SECONDS = 300;

/** The fee rate, in sats per 1000 vB: the 6-block estimate, never below the 1008-block one or 0.1. */
export function feeRate(estimates: Record<string, number> | undefined): number {
  const target = estimates?.[FEE_TARGET] ?? FALLBACK_FEE_RATE;
  const floor = Math.max(estimates?.["1008"] ?? 0, MIN_FEE_RATE);
  return Math.ceil(Math.max(target, floor) * 1000);
}

export interface EsploraServerConfig {
  url: string;
  /** The block the server must have: the network's genesis, or for a fork its first block after it. */
  identityBlock: IdentityBlock;
  /** The chain's display name, for messages. */
  chainName: string;
  /** Where a passed identity check is remembered for the session. */
  cache?: SessionCache;
  /** The server reports how final a block is (`/flush/blocks`): a block counts as confirmed only from `CONFIRMED_AT`. */
  finality?: boolean;
  /** Seconds without a block after which the chain counts as stalled; never, if absent. */
  stallAfter?: number;
  /**
   * What a raw transaction's outputs carry, by the chain's own module (Flush's `tokens`,
   * docs/adr/0013). With it, a coin of value 0 counts as the token its creating transaction lists
   * on it, and a result as the server's word (`unverified`). Without it, or if it answers undefined
   * (the module doesn't read tokens), such a coin adds nothing.
   */
  tokens?: (tx: string) => Promise<OutputTokens | undefined>;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

/** An unspent output, as Esplora lists it for an address or a script. */
export interface EsploraUtxo {
  txid: string;
  vout: number;
  /** Absent for a confidential output (Elements). */
  value?: number;
  /** Elements only; absent on a chain without assets. */
  asset?: string;
  confirmed: boolean;
}

/** Where a transaction stands. */
export interface EsploraTxStatus {
  confirmed: boolean;
  blockHeight?: number;
  blockHash?: string;
  /** The block's time, in seconds since the epoch. */
  blockTime?: number;
}

/**
 * An output as Esplora shows it. `value` is absent for a confidential output, `asset` on a chain
 * without assets (eCash) or when confidential (Elements).
 */
export interface EsploraOutput {
  scriptpubkey: string;
  value?: number;
  asset?: string;
}

/**
 * A transaction as Esplora shows it: what it spends (with the spent outputs) and pays. An Elements
 * input with `claimsDeposit` (Esplora's `is_pegin`) claims a Deposit's parent-chain output: its `txid` is
 * the parent chain's, and it has no `prevout`. One with `issues` (Esplora's `issuance`) issues an
 * asset: a new one, or more of one through its reissuance token.
 */
export interface EsploraTx {
  txid: string;
  vin: { txid: string; vout: number; prevout: EsploraOutput | null; claimsDeposit?: true; issues?: Issuance }[];
  vout: EsploraOutput[];
  status: EsploraTxStatus;
}

export type EsploraClient = ReturnType<typeof esploraClient>;

const HEX = /^[0-9a-f]*$/;
const HASH = /^[0-9a-f]{64}$/;
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

export function esploraClient({ url: baseUrl, identityBlock, chainName, cache, finality = false }: EsploraServerConfig, fetchFn: Fetch) {
  const url = baseUrl.replace(/\/+$/, "");
  const malformed = (what: string) => new SidechainServerError(url, `The Sidechain Server at ${url} sent a malformed ${what}.`);

  /** A call's response; any 2xx is an answer (mempool's instances send 203). */
  async function response(path: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: string }> {
    const answer = await serverFetch(fetchFn, url, path, init);
    return { status: answer.status, ok: answer.ok, body: await answer.text().catch(() => "") };
  }

  /** The server's reason, as plain text (Blockstream), `{"error": …}` (mempool's fork), or an HTML page's status alone. */
  function refused({ status, body }: { status: number; body: string }): SidechainServerError {
    const text = body.trim();
    let reason = text.startsWith("<") ? "" : text;
    try {
      const error = (JSON.parse(text) as Record<string, unknown>)?.error;
      if (typeof error === "string") reason = error;
    } catch {
      // Not JSON: the text itself.
    }
    return new SidechainServerError(url, `The Sidechain Server at ${url} refused: ${reason.slice(0, 200) || `HTTP ${status}`}`);
  }

  /** A GET's body. */
  async function get(path: string): Promise<string> {
    const answer = await response(path);
    if (!answer.ok) throw refused(answer);
    return answer.body;
  }

  /** `body` as JSON; `what` names it in the error if it isn't. */
  function parsed(body: string, what: string): unknown {
    try {
      return JSON.parse(body);
    } catch {
      throw malformed(what);
    }
  }

  /** A GET's body as JSON; `what` names it in the error if it isn't. */
  const getJson = async (path: string, what: string): Promise<unknown> => parsed(await get(path), what);

  function status(raw: unknown): EsploraTxStatus {
    const { confirmed, block_height, block_hash, block_time } = (raw ?? {}) as Record<string, unknown>;
    if (typeof confirmed !== "boolean") throw malformed("transaction status");
    if (!confirmed) return { confirmed };
    if (!isCount(block_height) || typeof block_hash !== "string" || !HASH.test(block_hash)) throw malformed("transaction status");
    if (block_time !== undefined && !isCount(block_time)) throw malformed("transaction status");
    return { confirmed, blockHeight: block_height, blockHash: block_hash, ...(block_time === undefined ? {} : { blockTime: block_time }) };
  }

  function output(raw: unknown): EsploraOutput {
    const { scriptpubkey, value, asset } = (raw ?? {}) as Record<string, unknown>;
    if (typeof scriptpubkey !== "string" || !HEX.test(scriptpubkey)) throw malformed("transaction");
    if (value !== undefined && !isCount(value)) throw malformed("transaction");
    if (asset !== undefined && (typeof asset !== "string" || !HASH.test(asset))) throw malformed("transaction");
    return { scriptpubkey, ...(value === undefined ? {} : { value }), ...(asset === undefined ? {} : { asset }) };
  }

  /** A list of transactions with their statuses as the server reports them. */
  function transactionList(body: unknown): EsploraTx[] {
    if (!Array.isArray(body)) throw malformed("list of transactions");
    return body.map(transaction);
  }

  const transactions = async (path: string) => settled(transactionList(await getJson(path, "list of transactions")));

  /** How the server pages an address's older transactions, once known: Blockstream's or mempool's. */
  let paging: "chain" | "afterTxid" | undefined;

  /**
   * The address's next page of confirmed transactions after the confirmed `txid`, statuses as the
   * server reports them. Blockstream's electrs pages with `/txs/chain/:txid`; mempool's fork 404s
   * there and pages with `?after_txid=` (and answers [] for a `txid` it doesn't list).
   */
  async function olderTxs(address: string, txid: string): Promise<EsploraTx[]> {
    const base = `/address/${encodeURIComponent(address)}/txs`;
    if (paging !== "afterTxid") {
      const answer = await response(`${base}/chain/${txid}`);
      if (answer.ok) {
        paging = "chain";
        return transactionList(parsed(answer.body, "list of transactions"));
      }
      if (answer.status !== 404 || paging === "chain") throw refused(answer);
      paging = "afterTxid";
    }
    return transactionList(await getJson(`${base}?after_txid=${txid}`, "list of transactions"));
  }

  function transaction(raw: unknown): EsploraTx {
    const tx = raw as Record<string, unknown>;
    if (typeof tx?.txid !== "string" || !HASH.test(tx.txid) || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) throw malformed("transaction");
    return {
      txid: tx.txid,
      vin: tx.vin.map((input: Record<string, unknown>) => {
        if (input?.is_coinbase === true) return { txid: "00".repeat(32), vout: 0xffffffff, prevout: null };
        if (typeof input?.txid !== "string" || !HASH.test(input.txid) || !isCount(input.vout)) throw malformed("transaction");
        const prevout = input.prevout === null ? null : output(input.prevout);
        const issuance = input.issuance as Record<string, unknown> | undefined | null;
        if (issuance != null && typeof issuance?.is_reissuance !== "boolean") throw malformed("transaction");
        return {
          txid: input.txid,
          vout: input.vout,
          prevout,
          ...(input.is_pegin === true ? { claimsDeposit: true as const } : {}),
          ...(issuance == null ? {} : { issues: issuance.is_reissuance ? ("reissuance" as const) : ("new" as const) }),
        };
      }),
      vout: tx.vout.map(output),
      status: status(tx.status),
    };
  }

  async function utxos(raw: unknown): Promise<EsploraUtxo[]> {
    if (!Array.isArray(raw)) throw malformed("list of outputs");
    const parsed = raw.map((utxo: Record<string, unknown>) => {
      const { txid, vout, value, asset } = utxo ?? {};
      if (typeof txid !== "string" || !HASH.test(txid) || !isCount(vout)) throw malformed("output");
      if (value !== undefined && !isCount(value)) throw malformed("output");
      if (asset !== undefined && (typeof asset !== "string" || !HASH.test(asset))) throw malformed("output");
      return { txid, vout, ...(value === undefined ? {} : { value }), ...(asset === undefined ? {} : { asset }), status: status(utxo.status) };
    });
    const settled = await settle(parsed.map((u) => u.status));
    return parsed.map(({ status: _, ...utxo }, i) => ({ ...utxo, confirmed: settled[i].confirmed }));
  }

  /** Blocks known to be final: that never changes, so they aren't asked about again. */
  const finalBlocks = new Set<string>();

  /** How final each block is, by hash; undefined for a block the server doesn't know. */
  async function blockFinality(hashes: string[]): Promise<Map<string, Finality | undefined>> {
    const answers = new Map<string, Finality | undefined>();
    const unknown = [];
    for (const hash of new Set(hashes)) {
      if (finalBlocks.has(hash)) answers.set(hash, "final");
      else unknown.push(hash);
    }
    for (let i = 0; i < unknown.length; i += FINALITY_BATCH) {
      const batch = unknown.slice(i, i + FINALITY_BATCH);
      const blocks = (await getJson(`/flush/blocks?hashes=${batch.join(",")}`, "block finality")) as Record<string, unknown>;
      if (typeof blocks !== "object" || blocks === null) throw malformed("block finality");
      for (const hash of batch) {
        const block = blocks[hash] as Record<string, Record<string, unknown> | undefined> | null | undefined;
        if (block == null) {
          answers.set(hash, undefined);
          continue;
        }
        const finality = block.finality?.status as Finality;
        if (!FINALITIES.includes(finality)) throw malformed("block finality");
        if (finality === "final") finalBlocks.add(hash);
        answers.set(hash, finality);
      }
    }
    return answers;
  }

  /**
   * The statuses as the wallet counts them. On a server that reports finality, a transaction in a
   * block short of `CONFIRMED_AT` (or one the server no longer knows) is still unconfirmed.
   */
  async function settle(statuses: EsploraTxStatus[]): Promise<EsploraTxStatus[]> {
    if (!finality) return statuses;
    const hashes = statuses.flatMap((s) => (s.confirmed ? [s.blockHash!] : []));
    if (hashes.length === 0) return statuses;
    const known = await blockFinality(hashes);
    const enough = (hash: string) => {
      const block = known.get(hash);
      return block !== undefined && FINALITIES.indexOf(block) >= FINALITIES.indexOf(CONFIRMED_AT);
    };
    return statuses.map((s) => (s.confirmed && !enough(s.blockHash!) ? { confirmed: false } : s));
  }

  async function settled(txs: EsploraTx[]): Promise<EsploraTx[]> {
    const statuses = await settle(txs.map((tx) => tx.status));
    return txs.map((tx, i) => (statuses[i] === tx.status ? tx : { ...tx, status: statuses[i] }));
  }

  return {
    url,

    /** The hash of the block at `height`, or undefined if the server hasn't reached it (404). */
    async blockHash(height: number): Promise<string | undefined> {
      const answer = await response(`/block-height/${height}`);
      if (answer.status === 404) return undefined;
      if (!answer.ok) throw refused(answer);
      const hash = answer.body.trim();
      if (!HASH.test(hash)) throw malformed("block hash");
      return hash;
    },

    /**
     * The identity check: Esplora has no `info`, but the block at the identity height proves which
     * chain it's on. For a fork (eCash), that's the first block after it: a server for the chain it
     * forked from, or for a later fork of it, has another block there. A pass is remembered for
     * the session (ADR 0002: on first contact and after every URL change); a failure never is.
     */
    async checkChain(): Promise<void> {
      const passed = cacheKey.identity(url, identityBlock);
      if ((await cache?.get<boolean>(passed)) === true) return;
      const { height, hash: expected } = identityBlock;
      const hash = await this.blockHash(height);
      if (hash === undefined) {
        if (height > 0) {
          throw new SidechainServerError(url, `The Sidechain Server at ${url} hasn't synced to block ${height}, so it can't show it's on ${chainName}.`);
        }
        throw refused({ status: 404, body: "Block not found" });
      }
      if (hash !== expected) {
        const which = height === 0 ? "genesis block" : `block ${height}`;
        throw new SidechainServerError(url, `The Sidechain Server at ${url} is on another chain: its ${which} is ${hash}, not ${chainName}'s ${expected}.`);
      }
      await cache?.set(passed, true);
    },

    async tipHeight(): Promise<number> {
      const height = Number((await get("/blocks/tip/height")).trim());
      if (!isCount(height)) throw malformed("tip height");
      return height;
    },

    /**
     * The tip's height and when it was mined (seconds since the epoch): how long the chain has gone
     * without a block.
     */
    async tip(): Promise<{ height: number; time: number }> {
      const blocks = await getJson("/blocks", "list of blocks");
      const { height, timestamp } = ((Array.isArray(blocks) ? blocks[0] : undefined) ?? {}) as Record<string, unknown>;
      if (!isCount(height) || !isCount(timestamp)) throw malformed("list of blocks");
      return { height, time: timestamp };
    },

    /** The address's unspent outputs, confirmed or not. */
    addressUtxos: async (address: string) => utxos(await getJson(`/address/${encodeURIComponent(address)}/utxo`, "list of outputs")),

    /** The unspent outputs to the script whose SHA-256 is `scripthash` (plain byte order, not Electrum's). */
    scripthashUtxos: async (scripthash: string) => utxos(await getJson(`/scripthash/${scripthash}/utxo`, "list of outputs")),

    /** How many transactions, confirmed or not, involve the address. */
    async addressTxCount(address: string): Promise<number> {
      const stats = (await getJson(`/address/${encodeURIComponent(address)}`, "address")) as Record<string, Record<string, unknown> | undefined>;
      const [chain, mempool] = [stats?.chain_stats?.tx_count, stats?.mempool_stats?.tx_count];
      if (!isCount(chain) || !isCount(mempool)) throw malformed("address");
      return chain + mempool;
    },

    async tx(txid: string): Promise<EsploraTx> {
      const tx = transaction(await getJson(`/tx/${txid}`, "transaction"));
      if (tx.txid !== txid) throw malformed("transaction");
      return (await settled([tx]))[0];
    },

    /**
     * The address's transactions, newest first: all of its mempool's (Esplora lists up to 50), then
     * its latest confirmed ones (up to `LISTED_CONFIRMED_TXS`). Older ones: `addressTxsBefore`.
     */
    addressTxs: (address: string) => transactions(`/address/${encodeURIComponent(address)}/txs`),

    /** The address's next `LISTED_CONFIRMED_TXS` confirmed transactions, newest first, after the confirmed `txid`. */
    addressTxsBefore: async (address: string, txid: string) => settled(await olderTxs(address, txid)),

    /**
     * The address's transactions, newest first: its mempool's, then its confirmed ones, reading up
     * to `pages` older pages past the first. `complete` unless older ones may be missing: the
     * mempool's list was full, the pages ran out first, or the server repeated a page.
     */
    async addressHistory(address: string, pages = HISTORY_PAGES): Promise<{ txs: EsploraTx[]; complete: boolean }> {
      const first = transactionList(await getJson(`/address/${encodeURIComponent(address)}/txs`, "list of transactions"));
      const mempool = first.filter((tx) => !tx.status.confirmed);
      const confirmed = first.filter((tx) => tx.status.confirmed);
      let complete = mempool.length < LISTED_MEMPOOL_TXS;
      const seen = new Set(confirmed.map((tx) => tx.txid));
      for (let page = confirmed, read = 0; page.length >= LISTED_CONFIRMED_TXS; read++) {
        if (read === pages) {
          complete = false;
          break;
        }
        page = (await olderTxs(address, page[page.length - 1].txid)).filter((tx) => tx.status.confirmed);
        const fresh = page.filter((tx) => !seen.has(tx.txid));
        if (fresh.length < page.length) {
          complete = false;
          break;
        }
        for (const tx of fresh) seen.add(tx.txid);
        confirmed.push(...fresh);
      }
      return { txs: await settled([...mempool, ...confirmed]), complete };
    },

    /** The raw transaction, hex. Whoever uses it checks it hashes to `txid`. */
    async txHex(txid: string): Promise<string> {
      const hex = (await get(`/tx/${txid}/hex`)).trim();
      if (!HEX.test(hex) || hex.length === 0 || hex.length % 2 !== 0) throw malformed("transaction");
      return hex;
    },

    /** Where the transaction stands; undefined if the server doesn't know it (404). */
    async txStatus(txid: string): Promise<EsploraTxStatus | undefined> {
      const answer = await response(`/tx/${txid}/status`);
      if (answer.status === 404) return undefined;
      if (!answer.ok) throw refused(answer);
      return (await settle([status(parsed(answer.body, "transaction status"))]))[0];
    },

    /**
     * The outpoint the asset's issuance spent (Esplora's `issuance_prevout`); undefined if the server
     * doesn't know the asset (404), or it wasn't issued by a transaction (the chain's own asset).
     * Whoever uses it derives the asset id from it: the server isn't trusted for that.
     */
    async assetIssuance(asset: string): Promise<{ txid: string; vout: number } | undefined> {
      const answer = await response(`/asset/${asset}`);
      if (answer.status === 404) return undefined;
      if (!answer.ok) throw refused(answer);
      const prevout = (parsed(answer.body, "asset") as Record<string, unknown> | null)?.issuance_prevout as Record<string, unknown> | undefined | null;
      if (prevout == null) return undefined;
      const { txid, vout } = prevout;
      if (typeof txid !== "string" || !HASH.test(txid) || !isCount(vout)) throw malformed("asset");
      return { txid, vout };
    },

    /**
     * Which transaction registered a Flush asset, as the node's `getasset` says (`/flush/rpc`);
     * undefined if the node doesn't know the asset. Whoever uses it checks that transaction is the
     * registration: the server isn't trusted for that (docs/adr/0013).
     */
    async assetRegistration(asset: string): Promise<{ txid: string; height: number } | undefined> {
      const answer = await response(`/flush/rpc/getasset?args=${encodeURIComponent(JSON.stringify([`0x${asset}`]))}`);
      if (answer.status === 404) return undefined;
      if (!answer.ok) throw refused(answer);
      let record: Record<string, unknown>;
      try {
        record = (JSON.parse(answer.body) ?? {}) as Record<string, unknown>;
      } catch {
        throw malformed("asset");
      }
      const { registration, registered } = record;
      if (typeof registration !== "string" || !HASH.test(registration) || !isCount(registered)) throw malformed("asset");
      return { txid: registration, height: registered };
    },

    /**
     * A Flush address's asset tokens as the node's DEX API counts them (`/flush/market/addresses/:a/holdings`),
     * results included: the server's word only, with no outpoints (docs/adr/0013).
     */
    async holdings(address: string): Promise<AssetAmount[]> {
      const answer = (await getJson(`/flush/market/addresses/${encodeURIComponent(address)}/holdings`, "list of holdings")) as Record<string, unknown>;
      if (!Array.isArray(answer?.items)) throw malformed("list of holdings");
      return answer.items.flatMap((item: Record<string, unknown>) => {
        const { kind, asset_id, amount_units } = item ?? {};
        if (kind !== "asset") return [];
        if (typeof asset_id !== "string" || !HASH.test(asset_id) || typeof amount_units !== "string" || !/^[0-9]+$/.test(amount_units)) {
          throw malformed("list of holdings");
        }
        return [{ asset: asset_id, amount: amount_units }];
      });
    },

    /** Fee rates (sat/vB) by confirmation target in blocks. */
    async feeEstimates(): Promise<Record<string, number>> {
      const estimates = await getJson("/fee-estimates", "fee estimate");
      if (typeof estimates !== "object" || estimates === null || Array.isArray(estimates)) throw malformed("fee estimate");
      const rates = Object.entries(estimates).filter(([target, rate]) => /^[0-9]+$/.test(target) && typeof rate === "number" && rate >= 0);
      return Object.fromEntries(rates) as Record<string, number>;
    },

    /** Broadcasts a raw transaction (hex); returns the txid the server reports. */
    async broadcast(tx: string): Promise<string> {
      const answer = await response("/tx", { method: "POST", body: tx, headers: { "Content-Type": "text/plain" } });
      if (!answer.ok) throw refused(answer);
      const txid = answer.body.trim();
      if (!HASH.test(txid)) throw malformed("txid");
      return txid;
    },
  };
}

export function esploraServer(config: EsploraServerConfig, fetchFn: Fetch): SidechainServer {
  const client = esploraClient(config, fetchFn);
  const { url } = client;

  /**
   * What the transaction `txid` lists on its outputs, by the chain's module: its raw transaction
   * comes from the session's cache or the server, and is kept only once the module's txid for it
   * is `txid`. Read once per state, however many of its outputs the watch holds.
   */
  function outputTokens(txid: string, read: Map<string, Promise<OutputTokens | undefined>>): Promise<OutputTokens | undefined> {
    const tokens = config.tokens!;
    if (!read.has(txid)) {
      read.set(
        txid,
        (async () => {
          const key = cacheKey.tx(txid);
          const cached = await config.cache?.get<string>(key);
          const tx = cached ?? (await client.txHex(txid));
          const listed = await tokens(tx);
          if (listed === undefined) return undefined;
          if (listed.txid !== txid) throw new SidechainServerError(url, `The Sidechain Server at ${url} sent another transaction for ${txid}.`);
          if (cached === undefined) await config.cache?.set(key, tx);
          return listed;
        })(),
      );
    }
    return read.get(txid)!;
  }

  /**
   * The address's explicit outputs, confirmed or not. Confidential ones (commitments, no `value`)
   * aren't counted. Bitcoin's Esplora (eCash) has no assets: its outputs carry none, and count as
   * the chain's coin. Esplora already leaves out outputs spent in its mempool. With `tokens`
   * (Flush), a coin of value 0 is the asset token its creating transaction lists on it, if any;
   * `results` says whether the address holds one whose token only the server can tell.
   */
  async function explicitOutputs(address: string, read: Map<string, Promise<OutputTokens | undefined>>): Promise<{ outputs: (AssetAmount & { confirmed: boolean })[]; results: boolean }> {
    const outputs: (AssetAmount & { confirmed: boolean })[] = [];
    let results = false;
    const utxos = await client.addressUtxos(address);
    const tokens = new Map<string, OutputTokens | undefined>();
    if (config.tokens !== undefined) {
      const txids = [...new Set(utxos.filter((u) => u.value === 0).map((u) => u.txid))];
      (await Promise.all(txids.map((txid) => outputTokens(txid, read)))).forEach((t, i) => tokens.set(txids[i], t));
    }
    for (const { txid, vout, value, asset, confirmed } of utxos) {
      if (value === undefined) continue;
      if (value === 0 && config.tokens !== undefined) {
        const listed: OutputToken | undefined = tokens.get(txid)?.outputs.find((o) => o.vout === vout);
        if (listed !== undefined && listed.token === undefined) results = true;
        if (listed?.token?.kind === "asset") outputs.push({ asset: listed.token.id, amount: listed.token.amount, confirmed });
        continue;
      }
      outputs.push({ asset: asset ?? NATIVE_COIN, amount: String(value), confirmed });
    }
    return { outputs, results };
  }

  /**
   * What `holdings` says the address has beyond the asset tokens the wallet read itself: the
   * tokens on its result outputs, as the server alone reports them (docs/adr/0013).
   */
  async function unverifiedTokens(address: string, readable: (AssetAmount & { confirmed: boolean })[]): Promise<AssetAmount[]> {
    const read = new Map<string, bigint>();
    for (const { asset, amount } of readable) read.set(asset, (read.get(asset) ?? 0n) + BigInt(amount));
    return (await client.holdings(address)).flatMap(({ asset, amount }) => {
      const beyond = BigInt(amount) - (read.get(asset) ?? 0n);
      return beyond > 0n ? [{ asset, amount: beyond.toString() }] : [];
    });
  }

  const listed = (totals: Map<string, bigint>) => [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() }));

  /** Runs `query` on every watched address, QUERIES_AT_ONCE at a time; answers in address order. */
  async function eachAddress<T>({ receive, change }: WatchData, query: (address: string) => Promise<T>): Promise<T[]> {
    const addresses = [...receive, ...change].map((a) => a.address);
    const answers: T[] = [];
    for (let i = 0; i < addresses.length; i += QUERIES_AT_ONCE) answers.push(...(await Promise.all(addresses.slice(i, i + QUERIES_AT_ONCE).map(query))));
    return answers;
  }

  /**
   * The wallet's view of a transaction: its net change per asset, from the outputs it pays and
   * spends of the watch's scripts; whether it's the wallet's Deposit (an M5 it funded); and whether
   * it's a Deposit's credit (on a Slot, an input claiming the Deposit).
   */
  function entry(tx: EsploraTx, ours: Set<string>, treasuries: TreasuryScript[], trusted: (tx: EsploraTx) => boolean): HistoryEntry {
    const net = new Map<string, bigint>();
    let hidden = false;
    const add = ({ value, asset }: EsploraOutput, sign: bigint) => {
      if (value === undefined) {
        hidden = true;
        return;
      }
      const key = asset ?? NATIVE_COIN;
      net.set(key, (net.get(key) ?? 0n) + sign * BigInt(value));
    };
    const isOurs = (output: EsploraOutput | null) => output !== null && ours.has(output.scriptpubkey);
    for (const { prevout } of tx.vin) if (isOurs(prevout)) add(prevout!, -1n);
    for (const output of tx.vout) if (isOurs(output)) add(output, 1n);
    // Elements' fee is an output with an empty script.
    const toSelf = tx.vin.every(({ prevout }) => isOurs(prevout)) && tx.vout.every((o) => o.scriptpubkey === "" || isOurs(o));
    const funded = tx.vin.some(({ prevout }) => isOurs(prevout));
    const depositTo = funded
      ? treasuries.find(({ scriptPubkey }) => tx.vout.some((o, vout) => o.scriptpubkey === scriptPubkey && isM5(tx, vout)))?.slot
      : undefined;
    const depositFrom = tx.vin.find((input) => input.claimsDeposit)?.txid;
    const issuance = tx.vin.find((input) => input.issues !== undefined && isOurs(input.prevout))?.issues;
    const { confirmed, blockTime } = tx.status;
    return {
      txid: tx.txid,
      amounts: listed(new Map([...net].filter(([, amount]) => amount !== 0n))),
      confirmed,
      ...(confirmed && blockTime !== undefined ? { time: blockTime } : {}),
      ...(confirmed ? {} : { trusted: trusted(tx) }),
      ...(hidden ? { hidden } : {}),
      ...(toSelf ? { toSelf } : {}),
      ...(depositTo === undefined ? {} : { depositTo }),
      ...(depositFrom === undefined ? {} : { depositFrom }),
      ...(issuance === undefined ? {} : { issuance }),
    };
  }

  /** The tip's time, if the chain has made no block for `stallAfter` seconds. */
  async function stalled(): Promise<number | undefined> {
    if (config.stallAfter === undefined) return undefined;
    const { time } = await client.tip();
    const now = Math.floor((config.now ?? Date.now)() / 1000);
    return now - time >= config.stallAfter ? time : undefined;
  }

  // Over Esplora the wallet builds and broadcasts transfers itself (send.ts, docs/adr/0006).
  const notHere = () => new SidechainServerError(url, `The Sidechain Server at ${url} speaks Esplora: it doesn't build transfers.`);

  return {
    url,
    async state(watch) {
      await client.checkChain();
      const confirmed = new Map<string, bigint>();
      const unconfirmed = new Map<string, bigint>();
      const unverified = new Map<string, bigint>();
      const read = new Map<string, Promise<OutputTokens | undefined>>();
      const byAddress = (address: string) =>
        explicitOutputs(address, read).then(async (held) => ({ ...held, unverified: held.results ? await unverifiedTokens(address, held.outputs) : [] }));
      const [held, stalledSince] = await Promise.all([eachAddress(watch, byAddress), stalled()]);
      for (const { asset, amount, confirmed: isConfirmed } of held.flatMap((h) => h.outputs)) {
        const totals = isConfirmed ? confirmed : unconfirmed;
        totals.set(asset, (totals.get(asset) ?? 0n) + BigInt(amount));
      }
      for (const { asset, amount } of held.flatMap((h) => h.unverified)) unverified.set(asset, (unverified.get(asset) ?? 0n) + BigInt(amount));
      return {
        balances: listed(confirmed),
        unconfirmed: listed(unconfirmed),
        ...(unverified.size === 0 ? {} : { unverified: listed(unverified) }),
        ...(stalledSince === undefined ? {} : { stalledSince }),
      };
    },
    /**
     * Each watched address's transactions, merged: a spend touches several of them. Unconfirmed
     * first, then confirmed by height, newest first.
     */
    async history(watch, treasuries = []) {
      await client.checkChain();
      const lists = await eachAddress(watch, (address) => client.addressHistory(address));
      const txs = new Map<string, EsploraTx>();
      for (const tx of lists.flatMap((list) => list.txs)) txs.set(tx.txid, tx);
      const partial = lists.some((list) => !list.complete);
      const ours = new Set([...watch.receive, ...watch.change].map((a) => a.scriptPubkey));
      // Trust (Bitcoin Core's `IsTrusted`) needs each input's parent. A parent missing from the lists
      // counts as confirmed: it paid one of the wallet's addresses, and an address's list has all of
      // its mempool's transactions (up to 50), so only a confirmed parent can be left out (one older
      // than the latest 25). Past 50 pending transactions on one address, an unlisted pending parent
      // would pass for confirmed; the list is then marked `partial`.
      const trust = new Map<string, boolean>();
      const trusted = (tx: EsploraTx | undefined): boolean => {
        if (tx === undefined || tx.status.confirmed) return true;
        if (!trust.has(tx.txid)) {
          trust.set(tx.txid, tx.vin.every(({ txid, prevout }) => prevout !== null && ours.has(prevout.scriptpubkey) && trusted(txs.get(txid))));
        }
        return trust.get(tx.txid)!;
      };
      const height = ({ status }: EsploraTx) => (status.confirmed ? (status.blockHeight ?? 0) : Number.MAX_SAFE_INTEGER);
      const newestFirst = [...txs.values()].sort((a, b) => height(b) - height(a));
      return { entries: newestFirst.map((tx) => entry(tx, ours, treasuries, trusted)), partial };
    },
    buildTransfer: async () => {
      throw notHere();
    },
    submit: async () => {
      throw notHere();
    },
  };
}
