// The stub Esplora server: the Esplora endpoints the wallet uses (docs/adr/0002), answered from
// fixtures. The e2e build's Sidechain Servers. With `config.flush` it answers as Flush's explorer
// does (mempool.space's electrs fork plus `/flush/blocks`, docs/adr/0012), as recorded on #56,
// with the node reads tokens need (`getasset`, `holdings`, docs/adr/0013).
//
// Like the Elements explorer it stands in for, it sends no CORS headers by default: the extension
// reaches it through its `host_permissions`, as it reaches the real one. `config.cors` adds them
// for the web build's tests, whose pages can't (which is why Slot 24 is left out of the web
// build). Dependency-free node `http`.
import { createServer } from "node:http";
import { addressScript, parseTx, scripthash } from "./bitcoin-tx.mjs";
import { parseElementsTx } from "./elements-tx.mjs";

/**
 * @typedef {{ txid: string, vout: number, value?: number, asset?: string, valuecommitment?: string,
 *   assetcommitment?: string, confirmed: boolean, blockHeight?: number, blockHash?: string }} UtxoFixture
 * @typedef {{ hex: string, confirmed?: boolean, blockHeight?: number, blockHash?: string, blockTime?: number }} TxFixture
 * @typedef {{ identityBlock: { height: number, hash: string }, blocks?: Record<number, string>,
 *   tipHeight?: number, utxos?: Record<string, UtxoFixture[]>, addressTxCounts?: Record<string, number>,
 *   txs?: TxFixture[], addressTxs?: Record<string, object[]>, feeEstimates?: Record<string, number>, refuseBroadcast?: string,
 *   delayMs?: number, pathDelayMs?: Record<string, number>, txHexOverrides?: Record<string, string>, elements?: boolean,
 *   txStatuses?: Record<string, { confirmed: boolean, blockHeight?: number, blockHash?: string }>,
 *   broadcastTxid?: string, assets?: Record<string, object>, flush?: boolean,
 *   finality?: Record<string, "soft" | "anchored" | "final">, tipTime?: number,
 *   flushAssets?: Record<string, object>, holdings?: Record<string, object[]>, rejectReason?: string,
 *   marketHeight?: number, instantPayoutsFrom?: number, marketTrades?: Record<string, object>, marketDown?: boolean, blocksDown?: boolean,
 *   flushRpc?: Record<string, ((args: unknown[]) => unknown) | unknown>, flushRpcStatus?: Record<string, number> }} EsploraStubConfig
 */

/** How many confirmed transactions an address's list holds per page, as both electrs forks list them. */
const PAGE = 25;

/**
 * A stub answering from `config`, read on every request (a test may change it between calls):
 * - `GET /block-height/{height}`: `config.identityBlock`'s hash at its height, or `config.blocks`'
 *   (any other height is past the tip: 404); `GET /blocks/tip/height`: `config.tipHeight`;
 * - `GET /address/{address}/utxo`: `config.utxos[address]` (none if absent), each as Esplora shows
 *   it: explicit (`value`, `asset`) or confidential (commitments), with its `status`;
 *   `GET /address/{address}`: its `tx_count` (`config.addressTxCounts`, else its listed outputs);
 * - from the raw transactions in `config.txs` (confirmed or in the mempool), as an indexer would:
 *   `GET /scripthash/{sha256}/utxo` (outputs no listed transaction spends), `GET /tx/{txid}`
 *   (with each input's `prevout`, when its transaction is listed), `/tx/{txid}/hex` and
 *   `/tx/{txid}/status` (`config.txHexOverrides[txid]` answers `/hex` instead, as a lying server would);
 * - `GET /address/{address}/txs`: `config.addressTxs[address]` (Esplora's JSON: Elements
 *   transactions, which the stub can't parse; mempool's first, then confirmed newest first), else
 *   the transactions in `config.txs` that pay or spend from the address's script: the mempool's
 *   first, newest first, then the 25 latest confirmed. Older pages: `/txs/chain/{txid}`
 *   (Blockstream), or with `config.flush` `?after_txid={txid}` (mempool's fork; `/txs/chain` 404s);
 * - `GET /blocks`: the tip, with `config.tipTime` (default: now) as its timestamp;
 * - `GET /fee-estimates`: `config.feeEstimates` (404 if absent);
 * - `GET /asset/{id}`: `config.assets[id]` as given (Esplora's JSON, e.g. its `issuance_prevout`), else 404;
 * - `POST /tx`: parses the transaction, adds it to `config.txs` unconfirmed and answers its txid,
 *   or refuses with `config.refuseBroadcast`. With `config.elements`, it parses an Elements
 *   transaction instead, which it only records in `config.txStatuses` (unconfirmed);
 * - `GET /tx/{txid}/status`: `config.txStatuses[txid]` first, if listed (a test may confirm or
 *   drop a broadcast there).
 * Every answer waits `config.delayMs` (default none), as a slow public server does, or
 * `config.pathDelayMs[path]` for that path, as a server stuck on one query does.
 *
 * With `config.flush`, as Flush's explorer answers: `/flush/blocks?hashes=a,b` gives each block's
 * finality (`config.finality[hash]`, default `final`; null for a block it doesn't know; 503 with
 * `config.blocksDown`); a coinbase
 * input has `txid: ""`; `/utxo` statuses have no `block_time`; `/fee-estimates` is HTTP 203; a
 * height past the tip is HTTP 500; errors are JSON `{ error }`, and unknown routes an HTML 404.
 * `/flush/rpc/getasset?args=["0x<id>"]` answers `config.flushAssets[id]` (getasset's JSON), else 404
 * `{ error: "Not found" }`; `/flush/market/addresses/{address}/holdings` answers
 * `{ items: config.holdings[address] ?? [], address }`; `/flush/market/status` answers the height its
 * index reached (`config.marketHeight`, else the tip) and, with `config.instantPayoutsFrom`, the
 * height payouts are instant from (`launch_params.v7_height`), or 503 with `config.marketDown`;
 * `/flush/market/trades/{txid}` answers `config.marketTrades[txid]` (the API's outcome, as given),
 * else 404 `{ error: "Not found" }`; `POST /txs/test` answers each transaction `allowed`, or
 * refused with `config.rejectReason` as its `reject-reason`. Any other `/flush/rpc/{method}`
 * answers `config.flushRpc[method]` (a function of the args, or JSON as is;
 * `undefined` from the function: 404), else 404; `config.flushRpcStatus[method]` answers that HTTP
 * status with `{ error }` instead, as the explorer does when the node can't answer (501, 503).
 */
export function createEsploraStub(config) {
  /** Every request, in order: its path, or `POST <path>`. */
  const requests = [];
  /** Every transaction broadcast, hex. */
  const broadcasts = [];
  /** Each broadcast's `maxburnamount` (ECX), or null without one, in order. */
  const burnAllowances = [];

  const status = ({ confirmed = true, blockHeight = 1, blockHash = "00".repeat(32), blockTime = 1792000000 }) =>
    confirmed ? { confirmed, block_height: blockHeight, block_hash: blockHash, block_time: blockTime } : { confirmed };
  /** An error with `text`: plain on Blockstream's electrs, `{ error }` on Flush's explorer. */
  const error = (code, text) => [code, config.flush ? { error: text } : text];
  /** Every block hash the stub knows: its identity block, `config.blocks`' and its transactions'. */
  const knownBlocks = () =>
    new Set([config.identityBlock.hash, ...Object.values(config.blocks ?? {}), "00".repeat(32), ...(config.txs ?? []).map((t) => t.blockHash).filter(Boolean)]);

  /**
   * An address's list from `txs` (Esplora's JSON, newest first): the first page is the mempool's
   * and the first PAGE confirmed; `after` gives the PAGE confirmed after that txid ([] if absent).
   */
  function page(txs, after) {
    if (!Array.isArray(txs)) return txs; // a malformed list, as given
    const confirmed = txs.filter((tx) => tx.status?.confirmed !== false);
    if (after === undefined) return [...txs.filter((tx) => tx.status?.confirmed === false), ...confirmed.slice(0, PAGE)];
    const at = confirmed.findIndex((tx) => tx.txid === after);
    return at === -1 ? [] : confirmed.slice(at + 1, at + 1 + PAGE);
  }

  /** `config.txs`, parsed, by txid. */
  function indexed() {
    const txs = new Map();
    for (const fixture of config.txs ?? []) txs.set(parseTx(fixture.hex).txid, { ...parseTx(fixture.hex), fixture });
    return txs;
  }

  function txJson(tx, txs) {
    return {
      txid: tx.txid,
      version: tx.version,
      locktime: tx.locktime,
      vin: tx.inputs.map((input) => {
        if (input.txid === "00".repeat(32) && input.vout === 0xffffffff) {
          // Flush's explorer names a coinbase input's txid "" and its vout 0.
          return { txid: config.flush ? "" : input.txid, vout: config.flush ? 0 : input.vout, prevout: null, is_coinbase: true, sequence: input.sequence };
        }
        const prev = txs.get(input.txid)?.outputs[input.vout];
        return {
          txid: input.txid,
          vout: input.vout,
          prevout: prev ? { scriptpubkey: prev.script, value: prev.value } : null,
          scriptsig: input.script,
          witness: input.witness,
          is_coinbase: false,
          sequence: input.sequence,
        };
      }),
      vout: tx.outputs.map((output) => ({ scriptpubkey: output.script, value: output.value })),
      status: status(tx.fixture),
    };
  }

  function route(method, pathname, body, query) {
    if (method === "POST" && pathname === "/tx") {
      if (config.refuseBroadcast) return error(400, config.refuseBroadcast);
      let tx;
      try {
        tx = config.elements ? parseElementsTx(body.trim()) : parseTx(body.trim());
      } catch (error) {
        return [400, `sendrawtransaction RPC error: {"code":-22,"message":"TX decode failed: ${error.message}"}`];
      }
      broadcasts.push(body.trim());
      burnAllowances.push(query.get("maxburnamount"));
      if (config.elements) (config.txStatuses ??= {})[tx.txid] = { confirmed: false };
      else (config.txs ??= []).push({ hex: body.trim(), confirmed: false });
      // `config.broadcastTxid` answers another txid than the one broadcast, as a lying server would.
      return [200, config.broadcastTxid ?? tx.txid];
    }
    if (config.flush && method === "POST" && pathname === "/txs/test") {
      const reason = config.rejectReason;
      return [200, JSON.parse(body).map((hex) => ({ txid: parseTx(hex).txid, allowed: !reason, ...(reason && { "reject-reason": reason }) }))];
    }
    if (method !== "GET") return [405, "Method not allowed"];

    const height = /^\/block-height\/([0-9]+)$/.exec(pathname);
    if (height) {
      const { identityBlock, blocks = {} } = config;
      const h = Number(height[1]);
      const hash = h === identityBlock.height ? identityBlock.hash : blocks[h];
      if (hash === undefined) return config.flush ? [500, { error: "Failed to get block at height" }] : [404, "Block not found"];
      return [200, hash];
    }
    if (pathname === "/blocks/tip/height") return [200, String(config.tipHeight ?? config.identityBlock.height)];
    if (pathname === "/blocks") {
      const height = config.tipHeight ?? config.identityBlock.height;
      return [200, [{ height, timestamp: config.tipTime ?? Math.floor(Date.now() / 1000) }]];
    }
    if (pathname === "/fee-estimates") return config.feeEstimates ? [config.flush ? 203 : 200, config.feeEstimates] : error(404, "Not found");
    if (config.flush && pathname === "/flush/blocks") {
      if (config.blocksDown) return [503, { error: "Busy" }];
      const hashes = (query.get("hashes") ?? "").split(",");
      if (hashes.length > 30 || !hashes.every((h) => /^[0-9a-f]{64}$/.test(h))) return [400, { error: "From 1 to 30 block hashes" }];
      const known = knownBlocks();
      const anchors = { soft: 0, anchored: 1, final: 3 };
      return [
        200,
        Object.fromEntries(
          hashes.map((hash) => {
            const finality = config.finality?.[hash] ?? (known.has(hash) ? "final" : undefined);
            return [hash, finality === undefined ? null : { hash, finality: { status: finality, anchors: anchors[finality] } }];
          }),
        ),
      ];
    }
    if (config.flush && pathname === "/flush/rpc/getasset") {
      let id;
      try {
        [id] = JSON.parse(query.get("args") ?? "[]");
      } catch {
        return [400, { error: "Invalid arguments" }];
      }
      const record = typeof id === "string" && id.startsWith("0x") ? config.flushAssets?.[id.slice(2)] : undefined;
      return record ? [200, record] : [404, { error: "Not found" }];
    }
    const rpc = config.flush ? /^\/flush\/rpc\/([a-z]+)$/.exec(pathname) : null;
    if (rpc && rpc[1] !== "getasset") {
      const status = config.flushRpcStatus?.[rpc[1]];
      if (status !== undefined) return [status, { error: status === 503 ? "Busy" : "Not implemented" }];
      let args;
      try {
        args = JSON.parse(query.get("args") ?? "[]");
      } catch {
        return [400, { error: "Invalid arguments" }];
      }
      const answer = config.flushRpc?.[rpc[1]];
      const value = typeof answer === "function" ? answer(args) : answer;
      return value === undefined ? [404, { error: "Not found" }] : [200, value];
    }
    const holdings = config.flush ? /^\/flush\/market\/addresses\/([^/]+)\/holdings$/.exec(pathname) : null;
    if (holdings) {
      const address = decodeURIComponent(holdings[1]);
      return [200, { items: config.holdings?.[address] ?? [], address }];
    }
    if (config.flush && pathname === "/flush/market/status") {
      if (config.marketDown) return [503, { error: "Busy" }];
      const instant = config.instantPayoutsFrom === undefined ? {} : { launch_params: { v7_height: config.instantPayoutsFrom, instant_payouts_active: true } };
      return [200, { flush: { height: config.marketHeight ?? config.tipHeight ?? 0 }, market_index: true, ...instant }];
    }
    const marketTrade = config.flush ? /^\/flush\/market\/trades\/([0-9a-f]{64})$/.exec(pathname) : null;
    if (marketTrade) return config.marketTrades?.[marketTrade[1]] ? [200, config.marketTrades[marketTrade[1]]] : [404, { error: "Not found" }];
    const asset = /^\/asset\/([0-9a-f]{64})$/.exec(pathname);
    if (asset) return config.assets?.[asset[1]] ? [200, config.assets[asset[1]]] : [404, "Asset id not found"];

    const utxo = /^\/address\/([^/]+)\/utxo$/.exec(pathname);
    if (utxo) {
      const address = decodeURIComponent(utxo[1]);
      return [
        200,
        (config.utxos?.[address] ?? []).map(({ confirmed, blockHeight, blockHash, ...output }) => {
          const { block_time: _, ...flushStatus } = status({ confirmed, blockHeight, blockHash });
          return { ...output, status: config.flush ? flushStatus : status({ confirmed, blockHeight, blockHash }) };
        }),
      ];
    }
    const addressTxs = /^\/address\/([^/]+)\/txs(?:\/chain\/([0-9a-f]{64}))?$/.exec(pathname);
    if (addressTxs) {
      const a = decodeURIComponent(addressTxs[1]);
      // Blockstream pages with `/txs/chain/:txid`; Flush's explorer only with `?after_txid=`.
      if (addressTxs[2] !== undefined && config.flush) return [404, `<!DOCTYPE html><pre>Cannot GET /api/v1${pathname}</pre>`];
      const after = addressTxs[2] ?? (config.flush ? (query.get("after_txid") ?? undefined) : undefined);
      if (config.addressTxs?.[a]) return [200, page(config.addressTxs[a], after)];
      let script;
      try {
        script = addressScript(a);
      } catch {
        return [400, "Invalid Bitcoin address"];
      }
      const txs = indexed();
      const touching = [...txs.values()].filter(
        (tx) => tx.outputs.some((o) => o.script === script) || tx.inputs.some((i) => txs.get(i.txid)?.outputs[i.vout]?.script === script),
      );
      const confirmed = (tx) => tx.fixture.confirmed !== false;
      const mempool = touching.filter((tx) => !confirmed(tx)).reverse();
      const chain = touching.filter(confirmed).sort((a, b) => (b.fixture.blockHeight ?? 1) - (a.fixture.blockHeight ?? 1));
      return [200, page([...mempool, ...chain].map((tx) => txJson(tx, txs)), after)];
    }
    const address = /^\/address\/([^/]+)$/.exec(pathname);
    if (address) {
      const a = decodeURIComponent(address[1]);
      const count = config.addressTxCounts?.[a] ?? config.utxos?.[a]?.length ?? 0;
      return [200, { address: a, chain_stats: { tx_count: count }, mempool_stats: { tx_count: 0 } }];
    }

    const byScript = /^\/scripthash\/([0-9a-f]{64})\/utxo$/.exec(pathname);
    if (byScript) {
      const txs = indexed();
      const spent = new Set([...txs.values()].flatMap((tx) => tx.inputs.map((i) => `${i.txid}:${i.vout}`)));
      return [
        200,
        [...txs.values()].flatMap((tx) =>
          tx.outputs.flatMap((output, vout) =>
            scripthash(output.script) === byScript[1] && !spent.has(`${tx.txid}:${vout}`)
              ? [{ txid: tx.txid, vout, value: output.value, status: status(tx.fixture) }]
              : [],
          ),
        ),
      ];
    }
    const tx = /^\/tx\/([0-9a-f]{64})(\/hex|\/status)?$/.exec(pathname);
    if (tx?.[2] === "/status" && config.txStatuses?.[tx[1]]) return [200, status(config.txStatuses[tx[1]])];
    if (tx) {
      const txs = indexed();
      const found = txs.get(tx[1]);
      if (found === undefined) return error(404, config.flush ? "No such mempool or blockchain transaction" : "Transaction not found");
      if (tx[2] === "/hex") return [200, config.txHexOverrides?.[tx[1]] ?? found.fixture.hex];
      if (tx[2] === "/status") return [200, status(found.fixture)];
      return [200, txJson(found, txs)];
    }
    // Each server's own wording for an unknown endpoint.
    if (config.flush) return [404, `<!DOCTYPE html><pre>Cannot GET /api/v1${pathname}</pre>`];
    return [404, `endpoint does not exist "${pathname}"`];
  }

  const server = createServer((request, response) => {
    if (config.cors) {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
    }
    const { pathname, searchParams } = new URL(request.url, "http://stub");
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(request.method === "GET" ? pathname : `${request.method} ${pathname}`);
      const [status, answer] = route(request.method, pathname, body, searchParams);
      const json = typeof answer !== "string";
      const html = typeof answer === "string" && answer.startsWith("<!DOCTYPE html>");
      setTimeout(() => {
        response.writeHead(status, { "Content-Type": json ? "application/json" : html ? "text/html" : "text/plain" });
        response.end(json ? JSON.stringify(answer) : answer);
      }, config.pathDelayMs?.[pathname] ?? config.delayMs ?? 0);
    });
  });

  return {
    /** Listens on `host:port`; resolves with the base URL. */
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(`http://${host}:${server.address().port}`));
      });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    /** Every request received, in order: its path, or `POST <path>`. */
    requests: () => [...requests],
    /** Every transaction broadcast, hex. */
    broadcasts: () => [...broadcasts],
    /** Each broadcast's `maxburnamount` (ECX), or null without one, in order. */
    burnAllowances: () => [...burnAllowances],
  };
}
