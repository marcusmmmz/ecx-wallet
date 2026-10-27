// Runs stubs on the e2e build's Sidechain Server URLs (e2e/scripts/build.mjs), answering for the
// "abandon … about" test wallet from the e2e fixtures: eCash's Esplora stub, one for Slot 24, and
// one for Flush (Slot 99) in Flush mode (its chain is right, but it holds no coins: Flush's addresses come
// from the Starter, which only the wallet derives).
//
//   pnpm --filter @ecx/stub-server start             Slot 24's Esplora stub, which the e2e build speaks to
//   pnpm --filter @ecx/stub-server start -- ecx-v0   the Standard Sidechain API stub, on the same URL
import { readFile } from "node:fs/promises";
import { E2E_FLUSH_SERVER, E2E_L1_SERVER, E2E_SIDECHAIN_SERVER } from "../../e2e/scripts/build.mjs";
import { encodeTx, parseTx } from "./bitcoin-tx.mjs";
import { createEsploraStub } from "./esplora.mjs";
import { createStubServer } from "./server.mjs";

const root = new URL("../../", import.meta.url);
const entry = JSON.parse(await readFile(new URL("core/elements/chain-entry.json", root), "utf8")).networks.betanet;
const { policyAsset } = entry.params;
const psets = JSON.parse(await readFile(new URL("e2e/fixtures/elements-psets.json", root), "utf8"));
const ADDRESS = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";

const api = process.argv[2] ?? "esplora";
const stub =
  api === "esplora"
    ? createEsploraStub({
        identityBlock: entry.identityBlock,
        utxos: { [ADDRESS]: [{ txid: "aa".repeat(32), vout: 0, value: 150000, asset: policyAsset, confirmed: true }] },
      })
    : api === "ecx-v0"
      ? createStubServer({
          chain: entry.chain,
          state: { [ADDRESS]: { balances: [{ asset: policyAsset, amount: "150000" }], history: [] } },
          transfers: [
            {
              outputs: [{ asset: policyAsset, amount: "120000", to: { address: "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc" } }],
              payload: psets.clear.payload,
            },
          ],
        })
      : undefined;
if (stub === undefined) throw new Error(`Unknown Server API ${api}: esplora or ecx-v0.`);
const url = new URL(E2E_SIDECHAIN_SERVER.url);

const l1Entry = JSON.parse(await readFile(new URL("core/l1/chain-entry.json", root), "utf8")).networks.betanet;
// 250 000 sats to BIP84's m/84'/0'/0'/0/0 for "abandon … about", from a made-up input. Slot 24 has
// no Treasury, so a Deposit is its first: the stub has Slot 24's pinned activation block.
const funding = encodeTx({
  inputs: [{ txid: "bb".repeat(32), vout: 0 }],
  outputs: [{ value: 250000, script: "0014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2" }],
});
const { activation } = entry;
const l1Stub = createEsploraStub({
  identityBlock: l1Entry.identityBlock,
  blocks: { [activation.height]: activation.hash },
  tipHeight: activation.height + 1000,
  feeEstimates: { 1: 0.97, 6: 0.5, 1008: 0.1 },
  txs: [{ hex: funding, confirmed: true }],
  utxos: { bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu: [{ txid: parseTx(funding).txid, vout: 0, value: 250000, confirmed: true }] },
});
const l1Url = new URL(E2E_L1_SERVER.url);
console.log(`stub esplora server for ${l1Entry.chain} at ${await l1Stub.listen(Number(l1Url.port), l1Url.hostname)}`);

const flushEntry = JSON.parse(await readFile(new URL("core/flush/chain-entry.json", root), "utf8")).networks.betanet;
const flushStub = createEsploraStub({ flush: true, identityBlock: flushEntry.identityBlock, tipHeight: 100, feeEstimates: { 6: 0.1, 1008: 0.1 } });
const flushUrl = new URL(E2E_FLUSH_SERVER.url);
console.log(`stub flush server for ${flushEntry.chain} at ${await flushStub.listen(Number(flushUrl.port), flushUrl.hostname)}`);
console.log(`stub ${api} Sidechain Server for ${entry.chain} at ${await stub.listen(Number(url.port), url.hostname)}`);
