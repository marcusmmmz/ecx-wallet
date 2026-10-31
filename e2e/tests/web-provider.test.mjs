// The web wallet as a Sidechain App's Provider (#85): with no extension to announce one, the app
// opens the wallet at `#/provider` in a popup and the two talk over postMessage.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  ABANDON, BROWSERS, ROOT, WALLET_PASSWORD, approvalIn, importWallet, launchWebWallet, openTestApp,
  serveFlushEsplora, serveL1Esplora, serveTestApp, serveWebWallet, waitForFunction,
} from "../harness.mjs";

const wallet = await importWallet();
const core = path.join(ROOT, "e2e", "dist", "core");
const vault = await wallet.loadVaultModule(await readFile(path.join(core, "vault.wasm")));
const flush = await wallet.loadChainModule(await readFile(path.join(core, "flush.wasm")));
const ADDRESS = flush.deriveAccount(vault.starter(ABANDON, "", 99), { receive: 1 }).receive[0].address;
const L1 = { cors: true, identityBlock: { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" }, utxos: {} };
const FLUSH = { cors: true, identityBlock: flush.chainEntry().networks.betanet.identityBlock, tipHeight: 10_000, txs: [], utxos: {} };
// The app's own origin: a different site from the wallet's (127.0.0.1).
const HOST = "webapp.localhost";

for (const browserName of BROWSERS) describe(`${browserName}: web Provider`, () => {
  let web;
  let app;
  let stubs;
  before(async () => {
    [web, app, ...stubs] = await Promise.all([serveWebWallet(), serveTestApp(), serveL1Esplora(L1), serveFlushEsplora(FLUSH)]);
  });
  after(async () => {
    await Promise.all([web?.close(), app?.close(), ...(stubs ?? []).map((stub) => stub?.close())]);
  });

  /** Imports the test wallet on the web wallet's origin, so a Provider window finds one. */
  async function importOnWebOrigin(session) {
    const page = await session.browser.newPage();
    await page.goto(`${web.url}#/import`);
    await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
    await page.type("[data-import-phrase]", ABANDON);
    await page.type("[data-new-password]", WALLET_PASSWORD);
    await page.type("[data-repeat-password]", WALLET_PASSWORD);
    await page.click("[data-submit]");
    await page.waitForSelector('[data-vault-state="unlocked"]', { timeout: 20_000 });
    await page.close();
  }

  test("an app connects from a click, unlocks and asks in the popup, is refused, hears its Grant go, and is disconnected when the popup closes", async () => {
    const session = await launchWebWallet(browserName);
    try {
      await importOnWebOrigin(session);
      const page = await openTestApp(session, app, HOST);
      const errors = [];
      page.on("pageerror", (error) => errors.push(`app: ${error.message}`));
      const found = await page.evaluate((url) => window.testApp.discover({ webWallet: url }), web.url);
      assert.deepEqual(found.map(({ name, rdns }) => ({ name, rdns })), [{ name: "ECX Wallet (web)", rdns: "cash.ecx.wallet.web" }]);

      // The first request opens the wallet's window, so it comes from a click. The params claim
      // another origin; the approval shows the one the browser reported.
      await page.evaluate(() => window.testApp.arm("connect", { slots: [99], methods: ["getAddresses"], origin: "https://forged.example" }));
      await page.click("[data-arm]");
      const target = await session.browser.waitForTarget((t) => t.url().includes("#/provider") || t.url().includes("#/approve/"), { timeout: 10_000 });
      const popup = await target.page();
      popup.on("pageerror", (error) => errors.push(`popup: ${error.message}`));
      await approvalIn(popup, { timeout: 20_000 });
      assert.equal(await popup.$eval("[data-origin]", (e) => e.textContent.trim()), app.origin(HOST));
      await popup.click("[data-approve]");
      assert.deepEqual(await page.evaluate(() => window.testApp.clicked), { result: { slots: [99], methods: ["getAddresses"] } });
      await popup.waitForSelector("[data-provider-origin]", { timeout: 10_000 });
      assert.equal(await popup.$eval("[data-provider-origin]", (e) => e.textContent.trim()), app.origin(HOST));

      // The popup is its own session, so it starts locked: the request asks to unlock there.
      const addresses = page.evaluate(() => window.testApp.request("getAddresses", { slot: 99 }));
      await popup.waitForSelector("[data-unlock-required]", { timeout: 20_000 });
      await popup.type("[data-password]", WALLET_PASSWORD);
      await popup.click("[data-unlock]");
      const answer = await addresses;
      assert.equal(answer.error, undefined, JSON.stringify(answer.error));
      assert.ok(JSON.stringify(answer.result).includes(ADDRESS), "the app gets the wallet's Flush address");

      // Rejecting a wider Grant refuses the request and keeps the narrower one.
      const wider = page.evaluate(() => window.testApp.request("connect", { slots: [99], methods: ["getAddresses", "sendTransfer"] }));
      await approvalIn(popup, { timeout: 20_000 });
      await popup.click("[data-reject]");
      assert.equal((await wider).error?.code, 4001);
      assert.deepEqual(
        (await page.evaluate(() => window.testApp.request("getGrant"))).result,
        { slots: [99], methods: ["getAddresses"], unlocked: true },
      );

      // Its Grant changing reaches the app as an event.
      await page.evaluate(() => window.testApp.listen("grantChanged"));
      assert.deepEqual(await page.evaluate(() => window.testApp.request("disconnect")), { result: null });
      await waitForFunction(page, () => window.testApp.events.length > 0, { timeout: 10_000 });
      assert.deepEqual(await page.evaluate(() => window.testApp.events), [["grantChanged", null]]);

      // The app reloads with the window still open: its next click finds that window, which says
      // `ready` again instead of loading anew.
      await page.reload();
      await waitForFunction(page, () => window.testApp !== undefined);
      await page.evaluate((url) => window.testApp.discover({ webWallet: url }), web.url);
      await page.evaluate(() => window.testApp.arm("getGrant"));
      await page.click("[data-arm]");
      assert.deepEqual(await page.evaluate(() => window.testApp.clicked), { result: null });
      assert.equal((await session.browser.pages()).filter((p) => p.url().startsWith(web.url)).length, 1, "the same window");

      // The window reloads during an approval: it serves again, and the app hears what it lost.
      const lost = page.evaluate(() => window.testApp.request("connect", { slots: [99], methods: ["getAddresses"] }));
      await approvalIn(popup, { timeout: 20_000 });
      await popup.reload();
      assert.equal((await lost).error?.code, 4900);

      // Closing the window answers what it was showing with 4900.
      const pending = page.evaluate(() => window.testApp.request("connect", { slots: [99], methods: ["getAddresses"] }));
      await approvalIn(popup, { timeout: 20_000 });
      await popup.close();
      assert.equal((await pending).error?.code, 4900);
      assert.deepEqual(errors, []);
    } finally {
      await session.close();
    }
  });

  test("the Provider window opened directly serves nothing", async () => {
    const session = await launchWebWallet(browserName);
    try {
      const page = await session.browser.newPage();
      await page.goto(`${web.url}#/provider`);
      await page.waitForSelector('[data-provider-window="unopened"]', { timeout: 10_000 });
    } finally {
      await session.close();
    }
  });
});
