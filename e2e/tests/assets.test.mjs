// The asset store's rules (no browser needed; docs/adr/0010): the Chain Entry's names come first,
// no stored asset takes one of its tickers in any case, a label is held to the registry's rules,
// and adding by contract checks it with the shipped elements.wasm against the server's outpoint.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { DIST_E2E, importWallet } from "../harness.mjs";

const { createAssets, loadChainModule } = await importWallet();

const CHAIN = "ecash:betanet-s24";
const ECX = { id: "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8", ticker: "ECX", name: "eCash on Elements+", decimals: 8, ecx: true };
const OTHER = "11".repeat(32);
const USDT = "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";
const USDT_PREVOUT = { txid: "9596d259270ef5bac0020435e6d859aea633409483ba64e232b8ba04ce288668", vout: 0 };
const USDT_CONTRACT =
  '{"entity":{"domain":"tether.to"},"issuer_pubkey":"0337cceec0beea0232ebe14cba0197a9fbd45fcf2ec946749de920e71434c2b904","name":"Tether USD","precision":8,"ticker":"USDt","version":0}';

function memoryStore() {
  const values = new Map();
  return {
    values,
    get: async (key) => structuredClone(values.get(key)),
    set: async (key, value) => void values.set(key, structuredClone(value)),
    remove: async (key) => void values.delete(key),
    keys: async () => [...values.keys()],
  };
}

const assetsWith = (store = memoryStore()) => createAssets({ store, entryAssets: async (chain) => (chain === CHAIN ? [ECX] : []) });

/** An issuance's Clear View, as far as the store reads it. */
const issuing = (asset, contract) => ({ inputs: [{ index: 0, asset: ECX.id, amount: "1", yours: true, issuance: { asset: { asset, amount: "1" }, contract } }] });
const contract = (ticker) => ({ name: "Example Asset", ticker, precision: 2, domain: "dex.example", issuerYours: true });

/** An Esplora client that knows only USDt, issued from `prevout`. */
const client = (prevout = USDT_PREVOUT) => ({
  url: "http://stub",
  checkChain: async () => {},
  assetIssuance: async (asset) => (asset === USDT ? prevout : undefined),
});

describe("the asset store", () => {
  test("names the Chain Entry's assets first, then stored ones, as decimals and marked by source", async () => {
    const assets = assetsWith();
    await assets.label(CHAIN, OTHER, { name: "My points", ticker: "PTS", precision: 0 });
    assert.deepEqual(await assets.named(CHAIN), [ECX, { id: OTHER, name: "My points", ticker: "PTS", decimals: 0, source: "label" }]);
    assert.deepEqual(await assets.named("ecash:betanet-s25"), [], "one store per network");
  });

  test("refuses a ticker of the Chain Entry's, in any case, whatever the source", async () => {
    const assets = assetsWith();
    for (const ticker of ["ECX", "ecx", "Ecx"]) {
      await assert.rejects(assets.label(CHAIN, OTHER, { name: "Fake", ticker, precision: 8 }), { code: -32602, message: /ticker .* is taken/ });
    }
    await assets.rememberSigned(CHAIN, issuing(OTHER, contract("eCx")));
    assert.deepEqual(await assets.list(CHAIN), [], "the signature stands; the asset just isn't named");
  });

  test("refuses an asset the Chain Entry names", async () => {
    await assert.rejects(assetsWith().label(CHAIN, ECX.id, { name: "Mine", ticker: "MINE", precision: 8 }), /already names asset/);
  });

  test("holds a label to the registry's rules for a name and ticker", async () => {
    const assets = assetsWith();
    for (const bad of [
      { name: "", ticker: "PTS", precision: 0 },
      { name: "Line\nbreak", ticker: "PTS", precision: 0 },
      { name: "Points", ticker: "P", precision: 0 },
      { name: "Points", ticker: "P T S", precision: 0 },
      { name: "Points", ticker: "PTS", precision: 9 },
    ]) {
      await assert.rejects(assets.label(CHAIN, OTHER, bad), { code: -32602 }, JSON.stringify(bad));
    }
    await assert.rejects(assets.label(CHAIN, "not an id", { name: "Points", ticker: "PTS", precision: 0 }), /64 hex digits/);
  });

  test("remembers each new asset a signed Clear View issues with a checked contract, and none without one", async () => {
    const assets = assetsWith();
    await assets.rememberSigned(CHAIN, issuing(OTHER, contract("EXA")));
    await assets.rememberSigned(CHAIN, issuing("22".repeat(32), undefined));
    assert.deepEqual(await assets.list(CHAIN), [{ id: OTHER, name: "Example Asset", ticker: "EXA", precision: 2, domain: "dex.example", source: "signed" }]);
  });

  test("a label renames a label, but not a name from the asset's contract; removing forgets either", async () => {
    const assets = assetsWith();
    await assets.label(CHAIN, OTHER, { name: "My points", ticker: "PTS", precision: 0 });
    await assets.label(CHAIN, OTHER, { name: "Points", ticker: "POINTS", precision: 2 });
    await assets.rememberSigned(CHAIN, issuing("22".repeat(32), contract("EXA")));
    await assert.rejects(assets.label(CHAIN, "22".repeat(32), { name: "Mine", ticker: "MINE", precision: 0 }), /named EXA from its contract/);
    assert.deepEqual((await assets.list(CHAIN)).map((a) => [a.ticker, a.source]), [["POINTS", "label"], ["EXA", "signed"]]);
    await assets.remove(CHAIN, "22".repeat(32));
    await assets.remove(CHAIN, OTHER.toUpperCase());
    assert.deepEqual(await assets.list(CHAIN), []);
  });

  test("an app's suggestion is checked before the user sees it, stores nothing until saved, and a user's label can replace it", async () => {
    const assets = assetsWith();
    const module = { declare: () => ({ binding: { chain: CHAIN }, capabilities: [] }) };
    const app = "https://dex.example";
    const suggested = await assets.suggestion(module, undefined, app, { asset: OTHER, label: { name: "DEX points", ticker: "DXP", precision: 2 } });
    assert.deepEqual(suggested, { chain: CHAIN, asset: { id: OTHER, name: "DEX points", ticker: "DXP", precision: 2, source: "app", origin: app } });
    assert.deepEqual(await assets.list(CHAIN), [], "nothing until the user approves");
    await assets.save(CHAIN, suggested.asset);
    assert.deepEqual((await assets.named(CHAIN)).at(-1), { id: OTHER, name: "DEX points", ticker: "DXP", decimals: 2, source: "app", origin: app });

    await assert.rejects(assets.suggestion(module, undefined, app, { asset: OTHER, label: { name: "Fake", ticker: "eCX", precision: 8 } }), /ticker eCX is taken/);
    await assert.rejects(assets.suggestion(module, undefined, app, { asset: OTHER, contract: "{}" }), /can't check contracts/, "no server to check it against");
    const again = await assets.suggestion(module, undefined, app, { asset: OTHER, label: { name: "DEX points v2", ticker: "DXP2", precision: 2 } });
    assert.equal(again.replaces?.ticker, "DXP");
    await assets.label(CHAIN, OTHER, { name: "Mine", ticker: "MINE", precision: 0 });
    assert.equal((await assets.list(CHAIN))[0].source, "label");
  });

  test("is plain storage: what it stores is readable without the password", async () => {
    const store = memoryStore();
    await assetsWith(store).label(CHAIN, OTHER, { name: "My points", ticker: "PTS", precision: 0 });
    assert.deepEqual(Object.keys(store.values.get(`assets:${CHAIN}`)), [OTHER]);
  });
});

describe("adding an asset by its contract", async () => {
  const elements = await loadChainModule(await readFile(path.join(DIST_E2E.chromium, "elements.wasm")));

  test("stores it once elements.wasm derives the asset id from the server's outpoint and the contract", async () => {
    const assets = assetsWith();
    const stored = await assets.addByContract(elements, client(), USDT.toUpperCase(), USDT_CONTRACT);
    assert.deepEqual(stored, { id: USDT, name: "Tether USD", ticker: "USDt", precision: 8, domain: "tether.to", contract: USDT_CONTRACT, source: "contract" });
    assert.deepEqual((await assets.named(CHAIN)).at(-1), { id: USDT, name: "Tether USD", ticker: "USDt", decimals: 8, source: "contract", domain: "tether.to" });
  });

  test("refuses a contract that isn't the asset's, a lying outpoint, an unknown asset, or a module without the capability", async () => {
    const assets = assetsWith();
    await assert.rejects(assets.addByContract(elements, client(), USDT, USDT_CONTRACT.replace("USDt", "USDT")), { code: -32602, message: /isn't the one asset/ });
    await assert.rejects(assets.addByContract(elements, client({ ...USDT_PREVOUT, vout: 1 }), USDT, USDT_CONTRACT), /isn't the one asset/);
    await assert.rejects(assets.addByContract(elements, client(), OTHER, USDT_CONTRACT), /doesn't know asset/);
    const without = { ...elements, declare: () => ({ ...elements.declare(), capabilities: [] }) };
    await assert.rejects(assets.addByContract(without, client(), USDT, USDT_CONTRACT), /can't check contracts/);
    assert.deepEqual(await assets.list(CHAIN), []);
  });
});
