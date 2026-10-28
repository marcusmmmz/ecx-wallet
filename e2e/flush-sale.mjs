// A Flush trade as Esplora and the market index report it: a sale of BROSEVELT, for the e2e suite
// (tests/flush-wallet.test.mjs) and the screenshots (screenshots.mjs).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import { ROOT } from "./harness.mjs";

/** BROSEVELT, a live Slot 99 asset: its registration and SetLogo (core/flush/tests/token-txs.json). */
export const BROSEVELT = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
export const LIVE_TXS = JSON.parse(await readFile(path.join(ROOT, "core/flush/tests/token-txs.json"), "utf8"));
export const REGISTRATION = "24fc101fccc71bc60845e190c2ad1e07b332fe7a6de99af37acdaaefdd9db891";

/** Core's VARINT (serialize.h), as a `BAST` marker writes amounts. */
function varint(n) {
  let x = BigInt(n);
  const bytes = [Number(x & 0x7fn)];
  while (x > 0x7fn) {
    x = (x >> 7n) - 1n;
    bytes.unshift(Number((x & 0x7fn) | 0x80n));
  }
  return bytes;
}
const internal = (id) => [...Buffer.from(id, "hex").reverse()];
/** A `BAST` marker's script: `kind` with `fields`, listing `{ n, asset, amount }` (a token) or `{ n }` (a result). */
function bast(kind, fields, listed) {
  const body = [...Buffer.from("BAST"), 0, kind, ...fields, listed.length];
  for (const { n, asset, amount } of listed) body.push(...varint(n), ...(asset === undefined ? [0xff] : [0, ...internal(asset), ...varint(amount)]));
  return Buffer.from([0x6a, ...(body.length <= 75 ? [body.length] : [0x4c, body.length]), ...body]).toString("hex");
}

/**
 * A sale of 12.34 BROSEVELT (1,234 units) through a pool for 0.000121 ECX, by the wallet whose
 * address pays `script`, and the coinbase that paid it (docs/adr/0017), all in blocks `blockHash`:
 * what a Flush stub adds to report it. That's the transactions (BROSEVELT's registration among
 * them), the index's asset and trade, and the sale's BROSEVELT change as a coin (home names an
 * asset from its registration once a balance shows it).
 */
export function flushSale(script, blockHash) {
  const pool = "77".repeat(32);
  const tokens = encodeTx({ inputs: [{ txid: "e6".repeat(32), vout: 0 }], outputs: [{ value: 0, script }, { value: 0, script: bast(0, [], [{ n: 0, asset: BROSEVELT, amount: 5_000 }]) }] });
  const ecx = encodeTx({ inputs: [{ txid: "e7".repeat(32), vout: 0 }], outputs: [{ value: 10_000, script }] });
  const sale = encodeTx({
    inputs: [{ txid: parseTx(tokens).txid, vout: 0 }, { txid: parseTx(ecx).txid, vout: 0 }],
    outputs: [
      { value: 0, script },
      { value: 0, script },
      { value: 0, script: bast(21, [...internal(BROSEVELT), 1, ...internal(pool), ...varint(1_234), ...varint(1_000), 22, ...Buffer.from(script, "hex")], [{ n: 0, asset: BROSEVELT, amount: 3_766 }, { n: 1 }]) },
      { value: 9_600, script },
    ],
  });
  const payout = encodeTx({ inputs: [{ txid: "00".repeat(32), vout: 0xffffffff, script: "03e80c00" }], outputs: [{ value: 0, script: "" }, { value: 12_100, script }] });
  const txid = parseTx(sale).txid;
  return {
    txid,
    payoutTxid: parseTx(payout).txid,
    txs: [
      { hex: tokens, blockHeight: 3280, blockHash },
      { hex: ecx, blockHeight: 3281, blockHash },
      { hex: sale, blockHeight: 3290, blockHash },
      { hex: payout, blockHeight: 3291, blockHash },
      { hex: LIVE_TXS[REGISTRATION], blockHeight: 604, blockHash },
    ],
    flushAssets: { [BROSEVELT]: { asset: BROSEVELT, registered: 604, registration: REGISTRATION } },
    marketTrades: {
      [txid]: { txid, kind: "swap", height: 3290, status: "filled", swap: { payouts: [{ what: "out", asset_id: "", amount_units: "12100", via: "coinbase" }] } },
    },
    change: { txid, vout: 0, value: 0, confirmed: true, blockHash },
  };
}
