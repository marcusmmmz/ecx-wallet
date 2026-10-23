// Seam 1, the asset store (#50, docs/adr/0010): the wallet names assets its Chain Entry doesn't,
// once it has checked their contracts. One it signed a new issuance of, with the contract as
// checked evidence; one the user adds by its contract, checked against the chain (the server's
// `issuance_prevout` and the contract's hash must derive the asset id). Never with a ticker of the
// Chain Entry's, and always marked as not this release's own names.
//
// Fixtures come from core/elements/tests/fixtures.rs; USDt's contract and outpoint are Liquid's.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { addressScript } from "@ecx/stub-server/bitcoin-tx";
import {
  BROWSERS,
  ROOT,
  homeSettled,
  launchWallet,
  openTestApp,
  openWalletPage,
  serveEsplora,
  serveL1Esplora,
  serveTestApp,
  setUpWallet,
} from "../harness.mjs";

const PSETS = JSON.parse(await readFile(path.join(ROOT, "e2e", "fixtures", "elements-psets.json"), "utf8"));
const CHAIN = "ecash:betanet-s24";
const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const USDT = "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";
const USDT_PREVOUT = { txid: "9596d259270ef5bac0020435e6d859aea633409483ba64e232b8ba04ce288668", vout: 0 };
const USDT_CONTRACT =
  '{"entity":{"domain":"tether.to"},"issuer_pubkey":"0337cceec0beea0232ebe14cba0197a9fbd45fcf2ec946749de920e71434c2b904","name":"Tether USD","precision":8,"ticker":"USDt","version":0}';
const EXA = PSETS.issuanceWithContract;
const AS_ECX = PSETS.issuanceAsEcx;

const L1 = { identityBlock: L1_FORK_BLOCK, txs: [] };
const ESPLORA = { identityBlock: { height: 0, hash: GENESIS }, assets: {} };

/** The wallet holds `amount` of `asset` at its first receive address, received in one transaction. */
function holds(holdings) {
  ESPLORA.utxos = { [RECEIVE_0]: holdings.map(([asset, value], i) => ({ txid: `e${i}`.repeat(32), vout: 0, value, asset, confirmed: true })) };
  ESPLORA.addressTxs = {
    [RECEIVE_0]: holdings.map(([asset, value], i) => ({
      txid: `e${i}`.repeat(32),
      vin: [{ txid: "a1".repeat(32), vout: 0, prevout: { scriptpubkey: "0014" + "ab".repeat(20), value: 1000, asset: POLICY_ASSET }, is_coinbase: false }],
      vout: [{ scriptpubkey: addressScript(RECEIVE_0), value, asset }],
      status: { confirmed: true, block_height: 10, block_hash: "00".repeat(32), block_time: 1792000000 },
    })),
  };
}

function signingRequest(payload, overrides = {}) {
  return {
    version: "1.0",
    id: `req-${Math.random().toString(36).slice(2)}`,
    chain: CHAIN,
    method: "signTransaction",
    format: "pset",
    payload,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

const withContract = ({ payload, contract }) => signingRequest(payload, { evidence: { assetContract: { 0: contract } } });

/** Slot 24's assets on home, as a user reads them: ticker, balance, and where a stored name came from. */
async function readAssets(session) {
  const page = await session.openPage("index.html#/");
  await homeSettled(page);
  const assets = await page.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return [...document.querySelectorAll('[data-account="24"] li[data-asset]')].map((li) => ({
      asset: li.getAttribute("data-asset"),
      ticker: text(li.querySelector("strong")),
      balance: text(li.querySelector("[data-balance]")),
      source: text(li.querySelector("[data-asset-source]")) ?? null,
    }));
  });
  await page.close();
  return Object.fromEntries(assets.map(({ asset, ...shown }) => [asset, shown]));
}

/** Slot 24's Activity amounts, once refreshed. */
async function readActivity(session) {
  const page = await openWalletPage(session, "#/chain/24");
  await page.click('[data-tab="activity"]');
  await page.waitForSelector("[data-activity]:not([data-refreshing]) [data-history-entry]", { timeout: 20_000 });
  const amounts = await page.$$eval("[data-history-amount]", (all) => all.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
  await page.waitForSelector("[data-chain-screen][data-settled]", { timeout: 20_000 });
  await page.close();
  return amounts;
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let app;
  let page;
  let stubs;
  /** A wallet page's message to the background: `{ ok, result }` or `{ ok: false, error }`. */
  let ask;
  before(async () => {
    let l1, slot;
    [session, app, l1, slot] = await Promise.all([launchWallet(browserName), serveTestApp(), serveL1Esplora(L1), serveEsplora(ESPLORA)]);
    stubs = [l1, slot];
    await setUpWallet(session);
    page = await openTestApp(session, app, "dex.localhost");
    const connecting = page.evaluate(() => window.testApp.request("connect", { slots: [24], methods: ["signTransaction"] }));
    await (await session.waitForApprovalWindow()).click("[data-approve]");
    assert.ok((await connecting).result, "connected");
    const wallet = await openWalletPage(session, "#/settings");
    ask = (message) => wallet.evaluate((m) => chrome.runtime.sendMessage(m), message);
  });
  after(async () => {
    await session?.close();
    await app?.close();
    for (const stub of stubs ?? []) await stub.close();
  });

  const sign = async (request) => {
    const signing = page.evaluate((r) => window.testApp.request("signTransaction", r), request);
    await (await session.waitForApprovalWindow()).click("[data-approve]");
    return signing;
  };

  test("before it signs an issuance, the wallet doesn't name the asset", async () => {
    holds([[EXA.asset, 1_000_000]]);
    assert.equal((await readAssets(session))[EXA.asset]?.ticker, "Unknown asset");
  });

  test("once it signs a new issuance with a checked contract, Home and Activity show the asset by its ticker and precision, with no mark on a balance row", async () => {
    assert.deepEqual(await sign(withContract(EXA)), { result: EXA.signed });
    holds([[EXA.asset, 1_000_000]]);
    assert.deepEqual((await readAssets(session))[EXA.asset], { ticker: "EXA", balance: "0.01 EXA", source: null });
    assert.deepEqual(await readActivity(session), ["+0.01 EXA"]);
  });

  test("the approval window marks an output paying a stored asset as named from its contract", async () => {
    const signing = page.evaluate((r) => window.testApp.request("signTransaction", r), signingRequest(EXA.payload));
    const approval = await session.waitForApprovalWindow();
    const output = await approval.$eval("[data-output]", (e) => ({
      text: e.textContent.replace(/\s+/g, " ").trim(),
      source: e.querySelector("[data-asset-source]")?.textContent.replace(/\s+/g, " ").trim(),
    }));
    assert.match(output.text, /^0\.01 EXA /);
    assert.match(output.source, /^from its contract /);
    await approval.click("[data-reject]");
    assert.equal((await signing).error?.code, 4001);
  });

  test("an issuance whose contract takes the chain's ECX ticker is signed, but its asset stays unknown", async () => {
    assert.deepEqual(await sign(withContract(AS_ECX)), { result: AS_ECX.signed });
    holds([[AS_ECX.asset, 1_000_000]]);
    assert.deepEqual((await readAssets(session))[AS_ECX.asset], { ticker: "Unknown asset", balance: "1,000,000", source: null });
  });

  test("an asset added by its contract, checked against its issuance's outpoint, is named on Home", async () => {
    ESPLORA.assets = { [USDT]: { asset_id: USDT, issuance_prevout: USDT_PREVOUT, contract_hash: "00".repeat(32) } };
    const answer = await ask({ kind: "assets.addByContract", slot: 24, asset: USDT, contract: USDT_CONTRACT });
    assert.deepEqual(answer, {
      ok: true,
      result: { id: USDT, name: "Tether USD", ticker: "USDt", precision: 8, domain: "tether.to", contract: USDT_CONTRACT, source: "contract" },
    });
    holds([[USDT, 250_000_000]]);
    assert.deepEqual((await readAssets(session))[USDT], { ticker: "USDt", balance: "2.5 USDt", source: null });
  });

  test("a contract that isn't the asset's, a server lying about the outpoint, or an asset the server doesn't know is refused", async () => {
    const add = (asset, contract) => ask({ kind: "assets.addByContract", slot: 24, asset, contract });
    const other = "77".repeat(32);
    ESPLORA.assets = {
      [USDT]: { issuance_prevout: USDT_PREVOUT },
      [other]: { issuance_prevout: USDT_PREVOUT },
    };
    const renamed = await add(USDT, USDT_CONTRACT.replace("Tether USD", "Tether USD2"));
    assert.equal(renamed.error?.code, -32602);
    assert.match(renamed.error.message, /isn't the one asset .* was issued with/);
    const lying = await add(other, USDT_CONTRACT);
    assert.match(lying.error?.message, /isn't the one asset .* was issued with/, "the server's outpoint doesn't derive this id");
    const unknown = await add("88".repeat(32), USDT_CONTRACT);
    assert.match(unknown.error?.message, /doesn't know asset/);
  });

  test("a contract whose ticker is the chain's ECX's is refused", async () => {
    ESPLORA.assets = { [AS_ECX.asset]: { issuance_prevout: AS_ECX.issuancePrevout } };
    const answer = await ask({ kind: "assets.addByContract", slot: 24, asset: AS_ECX.asset, contract: AS_ECX.contract });
    assert.equal(answer.error?.code, -32602);
    assert.match(answer.error.message, /ticker ECX is taken/);
  });
});
