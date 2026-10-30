// Seam 1, the Assets screen (#51, docs/adr/0010): the asset store's entries per sidechain, each with
// its source and full id. The user adds one by its contract (checked against the chain) or labels
// one, renames a label and removes any entry; an "Unknown asset" on Home or in Activity leads there.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { addressScript } from "@ecx/stub-server/bitcoin-tx";
import { BROWSERS, homeSettled, launchWallet, openWalletPage, serveEsplora, serveL1Esplora, setUpWallet, waitForFunction } from "../harness.mjs";

const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
// Tether USDt on Liquid: its contract and the outpoint its issuance spent.
const USDT = "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";
const USDT_CONTRACT =
  '{"entity":{"domain":"tether.to"},"issuer_pubkey":"0337cceec0beea0232ebe14cba0197a9fbd45fcf2ec946749de920e71434c2b904","name":"Tether USD","precision":8,"ticker":"USDt","version":0}';
const POINTS = "33".repeat(32);

const L1 = { identityBlock: L1_FORK_BLOCK, txs: [] };
const ESPLORA = {
  identityBlock: { height: 0, hash: GENESIS },
  assets: { [USDT]: { asset_id: USDT, issuance_prevout: { txid: "9596d259270ef5bac0020435e6d859aea633409483ba64e232b8ba04ce288668", vout: 0 } } },
  utxos: {
    [RECEIVE_0]: [
      { txid: "e0".repeat(32), vout: 0, value: 250_000_000, asset: USDT, confirmed: true },
      { txid: "e1".repeat(32), vout: 0, value: 1200, asset: POINTS, confirmed: true },
    ],
  },
  addressTxs: {
    [RECEIVE_0]: [
      {
        txid: "e0".repeat(32),
        vin: [{ txid: "a1".repeat(32), vout: 0, prevout: { scriptpubkey: "0014" + "ab".repeat(20), value: 1000, asset: POLICY_ASSET }, is_coinbase: false }],
        vout: [{ scriptpubkey: addressScript(RECEIVE_0), value: 250_000_000, asset: USDT }],
        status: { confirmed: true, block_height: 10, block_hash: "00".repeat(32), block_time: 1792000000 },
      },
    ],
  },
};

/** Sets a form field as typing would. */
const fill = (page, selector, value) =>
  page.$eval(selector, (e, v) => {
    e.value = v;
    e.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);

/** Slot 24's asset rows on home: ticker, or "Unknown asset", by asset id. */
async function homeTickers(session) {
  const page = await session.openPage("index.html#/");
  await homeSettled(page);
  const tickers = await page.$$eval('[data-account="24"] li[data-asset]', (all) =>
    Object.fromEntries(all.map((li) => [li.getAttribute("data-asset"), li.querySelector("strong").textContent.trim()])),
  );
  await page.close();
  return tickers;
}

/** The Assets screen's entries for Slot 24, as a user reads them. */
const readEntries = (page) =>
  page.$$eval('[data-assets-chain="24"] [data-stored-asset]', (all) =>
    all.map((e) => {
      const t = (x) => x?.textContent.replace(/\s+/g, " ").trim();
      return {
        id: t(e.querySelector("[data-stored-id]")),
        ticker: t(e.querySelector("[data-stored-ticker]")),
        source: t(e.querySelector("[data-stored-source]")),
        trust: e.querySelector("[data-asset-trust]")?.getAttribute("data-asset-trust") ?? null,
        rename: e.querySelector("[data-rename]") !== null,
      };
    }),
  );

/** Submits the open form and waits until it closes (added) or says why not. */
async function submit(page) {
  await page.click("[data-form-submit]");
  await waitForFunction(
    page,
    () => document.querySelector('[data-assets-screen][aria-busy="false"]') !== null && (!document.querySelector("[data-asset-form]") || document.querySelector("[data-form-error]") !== null),
    { timeout: 20_000 },
  );
  return page.evaluate(() => document.querySelector("[data-form-error]")?.textContent.trim() ?? null);
}

/** Opens the label form on Slot 24 with these fields. */
async function labelForm(page, { asset, name, ticker, precision }) {
  await page.click('[data-assets-chain="24"] [data-add-asset]');
  await page.click('[data-form-mode="label"]');
  await fill(page, "[data-form-asset]", asset);
  await fill(page, "[data-form-name]", name);
  await fill(page, "[data-form-ticker]", ticker);
  await fill(page, "[data-form-precision]", String(precision));
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let stubs;
  before(async () => {
    let l1, slot;
    [session, l1, slot] = await Promise.all([launchWallet(browserName), serveL1Esplora(L1), serveEsplora(ESPLORA)]);
    stubs = [l1, slot];
    await setUpWallet(session);
  });
  after(async () => {
    await session?.close();
    for (const stub of stubs ?? []) await stub.close();
  });

  test("Settings leads to the Assets screen, which lists none yet", async () => {
    const page = await openWalletPage(session, "#/settings");
    await page.click("[data-assets-link]");
    await page.waitForSelector("[data-assets-screen][data-screen-ready]");
    assert.equal(await page.$eval('[data-assets-chain="24"] [data-no-assets]', (e) => e.textContent.trim()), "No assets named here yet.");
    await page.close();
  });

  test("an Unknown asset on Home offers to name it; its contract, checked against the chain, names it", async () => {
    const page = await session.openPage("index.html#/");
    await homeSettled(page);
    await page.click(`[data-account="24"] li[data-asset="${USDT}"] [data-name-asset]`);
    await page.waitForSelector("[data-asset-form]", { timeout: 10_000 });
    assert.equal(await page.$eval("[data-form-asset]", (e) => e.value), USDT, "the form starts with the asset tapped");

    await fill(page, "[data-form-contract]", USDT_CONTRACT.replace("Tether USD", "Tether USD2"));
    assert.match(await submit(page), /isn't the one asset .* was issued with/, "a mismatch is refused, saying why");
    assert.deepEqual(await readEntries(page), []);

    await fill(page, "[data-form-contract]", USDT_CONTRACT);
    assert.equal(await submit(page), null);
    assert.deepEqual(await readEntries(page), [{ id: USDT, ticker: "USDt", source: "from its contract", trust: "unverified", rename: false }], "its full id and source; anyone could write a USDt contract");
    await page.close();
    assert.equal((await homeTickers(session))[USDT], "USDt");
  });

  test("a label names an asset with no contract, and can be renamed; a ticker of the chain's own is refused", async () => {
    const page = await openWalletPage(session, "#/assets");
    await labelForm(page, { asset: POINTS, name: "Fake eCash", ticker: "ecx", precision: 8 });
    assert.match(await submit(page), /ticker ecx is taken/);

    await fill(page, "[data-form-name]", "My points");
    await fill(page, "[data-form-ticker]", "PTS");
    await fill(page, "[data-form-precision]", "2");
    assert.equal(await submit(page), null);
    assert.deepEqual((await readEntries(page)).find((e) => e.id === POINTS), { id: POINTS, ticker: "PTS", source: "your label", trust: null, rename: true }, "the user's own label has no badge");

    await page.click(`[data-stored-asset="${POINTS}"] [data-rename]`);
    assert.equal(await page.$eval("[data-form-asset]", (e) => e.readOnly), true, "renaming keeps the asset");
    await fill(page, "[data-form-ticker]", "POINTS");
    assert.equal(await submit(page), null);
    assert.equal((await readEntries(page)).find((e) => e.id === POINTS)?.ticker, "POINTS");
    await page.close();
    assert.equal((await homeTickers(session))[POINTS], "POINTS");
  });

  test("a label can't replace a name from the asset's contract", async () => {
    const page = await openWalletPage(session, "#/assets");
    await labelForm(page, { asset: USDT, name: "Mine", ticker: "MINE", precision: 0 });
    assert.match(await submit(page), /named USDt from its contract/);
    await page.close();
  });

  test("removing an entry only forgets its name: the asset is Unknown again", async () => {
    const page = await openWalletPage(session, "#/assets");
    await page.click(`[data-stored-asset="${USDT}"] [data-remove]`);
    await waitForFunction(page, (id) => !document.querySelector(`[data-stored-asset="${id}"]`) && document.querySelector('[aria-busy="false"]') !== null, {}, USDT);
    assert.deepEqual((await readEntries(page)).map((e) => e.id), [POINTS]);
    await page.close();
    assert.equal((await homeTickers(session))[USDT], "Unknown asset");
  });

  test("an Unknown asset in Activity's details offers to name it", async () => {
    const page = await openWalletPage(session, "#/chain/24");
    await page.click('[data-tab="activity"]');
    await page.waitForSelector("[data-activity]:not([data-refreshing]) [data-history-entry]", { timeout: 20_000 });
    await page.click(`[data-history-entry="${"e0".repeat(32)}"]`);
    await page.waitForSelector("[data-activity-details] [data-name-asset]");
    assert.equal(await page.$eval("[data-activity-details] [data-name-asset]", (e) => e.getAttribute("href")), `#/assets/24/${USDT}`);
    await page.waitForSelector("[data-chain-screen][data-settled]", { timeout: 20_000 });
    await page.click("[data-activity-details] [data-name-asset]");
    await page.waitForSelector("[data-asset-form]", { timeout: 10_000 });
    assert.equal(await page.$eval("[data-form-asset]", (e) => e.value), USDT);
    await page.close();
  });
});
