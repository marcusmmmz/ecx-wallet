// The stub Esplora server: the Esplora endpoints the wallet uses (docs/adr/0002), answered from
// fixtures. The e2e build's Sidechain Servers.
//
// Like the Elements explorer it stands in for, it sends no CORS headers: the extension reaches it
// through its `host_permissions`, as it reaches the real one. Dependency-free node `http`.
import { createServer } from "node:http";
import { addressScript, parseTx, scripthash } from "./bitcoin-tx.mjs";
import { parseElementsTx } from "./elements-tx.mjs";

/**
 * @typedef {{ txid: string, vout: number, value?: number, asset?: string, valuecommitment?: string,
 *   assetcommitment?: string, confirmed: boolean }} UtxoFixture
 * @typedef {{ hex: string, confirmed?: boolean, blockHeight?: number, blockHash?: string, blockTime?: number }} TxFixture
 * @typedef {{ identityBlock: { height: number, hash: string }, blocks?: Record<number, string>,
 *   tipHeight?: number, utxos?: Record<string, UtxoFixture[]>, addressTxCounts?: Record<string, number>,
 *   txs?: TxFixture[], addressTxs?: Record<string, object[]>, feeEstimates?: Record<string, number>, refuseBroadcast?: string,
 *   delayMs?: number, pathDelayMs?: Record<string, number>, txHexOverrides?: Record<string, string>, elements?: boolean,
 *   txStatuses?: Record<string, { confirmed: boolean, blockHeight?: number, blockHash?: string }>,
 *   broadcastTxid?: string, assets?: Record<string, object> }} EsploraStubConfig
 */

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
 * - `GET /address/{address}/txs`: `config.addressTxs[address]` as given (Esplora's JSON: Elements
 *   transactions, which the stub can't parse), else the transactions in `config.txs` that pay or
 *   spend from the address's script, as Esplora lists them: the mempool's first, newest first,
 *   then the 25 latest confirmed;
 * - `GET /fee-estimates`: `config.feeEstimates` (404 if absent);
 * - `GET /asset/{id}`: `config.assets[id]` as given (Esplora's JSON, e.g. its `issuance_prevout`), else 404;
 * - `POST /tx`: parses the transaction, adds it to `config.txs` unconfirmed and answers its txid,
 *   or refuses with `config.refuseBroadcast`. With `config.elements`, it parses an Elements
 *   transaction instead, which it only records in `config.txStatuses` (unconfirmed);
 * - `GET /tx/{txid}/status`: `config.txStatuses[txid]` first, if listed (a test may confirm or
 *   drop a broadcast there).
 * Every answer waits `config.delayMs` (default none), as a slow public server does, or
 * `config.pathDelayMs[path]` for that path, as a server stuck on one query does.
 */
export function createEsploraStub(config) {
  /** Every request, in order: its path, or `POST <path>`. */
  const requests = [];
  /** Every transaction broadcast, hex. */
  const broadcasts = [];

  const status = ({ confirmed = true, blockHeight = 1, blockHash = "00".repeat(32), blockTime = 1792000000 }) =>
    confirmed ? { confirmed, block_height: blockHeight, block_hash: blockHash, block_time: blockTime } : { confirmed };

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

  function route(method, pathname, body) {
    if (method === "POST" && pathname === "/tx") {
      if (config.refuseBroadcast) return [400, config.refuseBroadcast];
      let tx;
      try {
        tx = config.elements ? parseElementsTx(body.trim()) : parseTx(body.trim());
      } catch (error) {
        return [400, `sendrawtransaction RPC error: {"code":-22,"message":"TX decode failed: ${error.message}"}`];
      }
      broadcasts.push(body.trim());
      if (config.elements) (config.txStatuses ??= {})[tx.txid] = { confirmed: false };
      else (config.txs ??= []).push({ hex: body.trim(), confirmed: false });
      // `config.broadcastTxid` answers another txid than the one broadcast, as a lying server would.
      return [200, config.broadcastTxid ?? tx.txid];
    }
    if (method !== "GET") return [405, "Method not allowed"];

    const height = /^\/block-height\/([0-9]+)$/.exec(pathname);
    if (height) {
      const { identityBlock, blocks = {} } = config;
      const h = Number(height[1]);
      const hash = h === identityBlock.height ? identityBlock.hash : blocks[h];
      return hash === undefined ? [404, "Block not found"] : [200, hash];
    }
    if (pathname === "/blocks/tip/height") return [200, String(config.tipHeight ?? config.identityBlock.height)];
    if (pathname === "/fee-estimates") return config.feeEstimates ? [200, config.feeEstimates] : [404, "Not found"];
    const asset = /^\/asset\/([0-9a-f]{64})$/.exec(pathname);
    if (asset) return config.assets?.[asset[1]] ? [200, config.assets[asset[1]]] : [404, "Asset id not found"];

    const utxo = /^\/address\/([^/]+)\/utxo$/.exec(pathname);
    if (utxo) {
      const address = decodeURIComponent(utxo[1]);
      return [200, (config.utxos?.[address] ?? []).map(({ confirmed, ...output }) => ({ ...output, status: status({ confirmed }) }))];
    }
    const addressTxs = /^\/address\/([^/]+)\/txs$/.exec(pathname);
    if (addressTxs) {
      const a = decodeURIComponent(addressTxs[1]);
      if (config.addressTxs?.[a]) return [200, config.addressTxs[a]];
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
      return [200, [...mempool, ...chain.slice(0, 25)].map((tx) => txJson(tx, txs))];
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
      if (found === undefined) return [404, "Transaction not found"];
      if (tx[2] === "/hex") return [200, config.txHexOverrides?.[tx[1]] ?? found.fixture.hex];
      if (tx[2] === "/status") return [200, status(found.fixture)];
      return [200, txJson(found, txs)];
    }
    // Esplora's own wording for an unknown endpoint.
    return [404, `endpoint does not exist "${pathname}"`];
  }

  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://stub");
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push(request.method === "GET" ? pathname : `${request.method} ${pathname}`);
      const [status, answer] = route(request.method, pathname, body);
      const json = typeof answer !== "string";
      setTimeout(() => {
        response.writeHead(status, { "Content-Type": json ? "application/json" : "text/plain" });
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
  };
}
