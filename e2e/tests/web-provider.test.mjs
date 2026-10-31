// The web wallet as a Sidechain App's Provider (#85, #91): with no extension to announce one, the
// app opens the wallet at `#/provider` in a popup, or the wallet frames the app in its Apps view,
// and the two talk over postMessage.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import * as esbuild from "esbuild";
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

/**
 * The demo app (demo/), bundled as its build does, on `demo.localhost`. `framedBy`: the wallet
 * origin it lets frame it, as demo/scripts/serve.mjs does (none: it sends no `frame-ancestors`).
 */
async function serveDemo(framedBy) {
  const bundle = await esbuild.build({ entryPoints: [path.join(ROOT, "demo", "src", "main.ts")], bundle: true, format: "esm", target: "es2022", write: false });
  const html = await readFile(path.join(ROOT, "demo", "src", "index.html"), "utf8");
  const server = createServer((request, response) => {
    const js = request.url.split("?")[0] === "/main.js";
    response.writeHead(200, {
      "Content-Type": js ? "text/javascript" : "text/html; charset=utf-8",
      ...(framedBy ? { "Content-Security-Policy": `frame-ancestors ${framedBy}` } : {}),
    });
    response.end(js ? bundle.outputFiles[0].text : html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://demo.localhost:${server.address().port}`, url: (query) => `http://demo.localhost:${server.address().port}/?${new URLSearchParams(query)}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * A page that isn't a Sidechain App, on `plain.localhost`: it loads no client library. `framing`:
 * its `frame-ancestors` (`'none'`: it refuses every frame).
 */
async function servePlainPage(framing) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `frame-ancestors ${framing}` });
    response.end("<!doctype html><title>Plain</title><p>Not an app.</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://plain.localhost:${server.address().port}/`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Waits for an approval drawn over the Apps view to finish rising into place, so a click lands on it. */
async function overlaySettled(page) {
  await approvalIn(page, { timeout: 20_000 });
  await waitForFunction(page, risen, { timeout: 10_000 }, "[data-app-approval] [data-approve]");
}

/** In the page: `selector` is there, and the overlay's entrance animations (not looping ones) are done. */
function risen(selector) {
  const overlay = document.querySelector("[data-app-approval]");
  return Boolean(document.querySelector(selector)) && overlay.getAnimations({ subtree: true }).every((a) => a.playState !== "running" || a.effect.getComputedTiming().iterations === Infinity);
}

/** The wallet page's frame once it holds a page of `origin`. */
async function frameOf(page, origin) {
  await waitForFunction(page, (o) => document.querySelector("[data-app-frame]")?.src.startsWith(o), { timeout: 10_000 }, origin);
  return page.waitForFrame((frame) => frame.url().startsWith(origin), { timeout: 10_000 });
}

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

  test("the demo app connects from its button, shows the wallet's address, and disconnects", async () => {
    const demo = await serveDemo();
    const session = await launchWebWallet(browserName);
    try {
      await importOnWebOrigin(session);
      const page = await session.browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(demo.url({ wallet: web.url, slot: 99 }));
      await page.waitForSelector("[data-connect]:not([disabled])", { timeout: 10_000 });
      assert.match(await page.$eval("[data-wallet]", (e) => e.textContent), /ECX Wallet \(web\)/);
      await page.click("[data-connect]");
      const popup = await (await session.browser.waitForTarget((t) => t.url().includes("#/provider") || t.url().includes("#/approve/"), { timeout: 10_000 })).page();
      await approvalIn(popup, { timeout: 20_000 });
      await popup.click("[data-approve]");
      await popup.waitForSelector("[data-unlock-required]", { timeout: 20_000 });
      await popup.type("[data-password]", WALLET_PASSWORD);
      await popup.click("[data-unlock]");
      await waitForFunction(page, () => document.querySelector("[data-address]")?.textContent !== "", { timeout: 20_000 });
      assert.equal(await page.$eval("[data-address]", (e) => e.textContent), ADDRESS);
      await page.click("[data-disconnect]");
      await page.waitForSelector("[data-connect]", { visible: true, timeout: 10_000 });
      assert.deepEqual(errors, []);
    } finally {
      await session.close();
      await demo.close();
    }
  });

  test("an app opened in the Apps view connects with no popup: refused, then approved and unlocked over the frame, which stays mounted", async () => {
    const demo = await serveDemo(new URL(web.url).origin);
    const session = await launchWebWallet(browserName);
    try {
      await importOnWebOrigin(session);
      const page = await session.browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${web.url}#/apps?url=${encodeURIComponent(demo.url({ wallet: web.url, slot: 99 }))}`);
      const app = await frameOf(page, demo.origin);
      await waitForFunction(page, () => document.querySelector("[data-app-origin]")?.textContent, { timeout: 10_000 });
      assert.equal(await page.$eval("[data-app-origin]", (e) => e.textContent), demo.origin);
      await waitForFunction(app, () => document.querySelector("[data-connect]")?.disabled === false, { timeout: 10_000 });
      // Named by the origin that frames it: any wallet speaking the protocol would be found.
      assert.equal(await app.$eval("[data-wallet]", (e) => e.textContent), `Wallet at ${new URL(web.url).origin}`);
      // Marks this document: a reload of the frame would lose it.
      await app.evaluate(() => (window.mounted = true));

      await app.click("[data-connect]");
      await overlaySettled(page);
      assert.ok(await page.$("[data-app-approval] [data-approval-ready]"), "the approval is drawn over the frame");
      await page.click("[data-reject]");
      await waitForFunction(app, () => /rejected/.test(document.querySelector("[data-status]")?.textContent ?? ""), { timeout: 10_000 });
      assert.equal(await page.$("[data-app-approval]"), null);

      await app.click("[data-connect]");
      await overlaySettled(page);
      await page.click("[data-approve]");
      await page.waitForSelector("[data-app-approval] [data-unlock-required]", { timeout: 20_000 });
      await waitForFunction(page, risen, { timeout: 10_000 }, "[data-app-approval] [data-unlock]");
      await page.type("[data-password]", WALLET_PASSWORD);
      await page.click("[data-unlock]");
      await waitForFunction(app, () => document.querySelector("[data-address]")?.textContent !== "", { timeout: 20_000 });
      assert.equal(await app.$eval("[data-address]", (e) => e.textContent), ADDRESS);
      assert.equal(await app.evaluate(() => window.mounted ?? null), true);
      assert.equal(await page.$("[data-app-approval]"), null);
      assert.equal((await session.browser.pages()).some((p) => p.url().includes("#/provider")), false, "no popup opened");

      await app.click("[data-disconnect]");
      await app.waitForSelector("[data-connect]", { visible: true, timeout: 10_000 });
      assert.deepEqual(errors, []);
    } finally {
      await session.close();
      await demo.close();
    }
  });

  test("the Apps view forgets the app's origin when its frame goes to another page, and says when a page doesn't connect", async () => {
    const demo = await serveDemo(new URL(web.url).origin);
    const [opted, refusing] = await Promise.all([servePlainPage(new URL(web.url).origin), servePlainPage("'none'")]);
    const session = await launchWebWallet(browserName);
    try {
      const page = await session.browser.newPage();
      await page.goto(`${web.url}#/apps?url=${encodeURIComponent(demo.url({ wallet: web.url, slot: 99 }))}`);
      const app = await frameOf(page, demo.origin);
      await waitForFunction(page, () => document.querySelector("[data-app-origin]")?.textContent, { timeout: 10_000 });
      // The app sends its frame to a page that allows the wallet to frame it but says nothing.
      await app.evaluate((url) => (location.href = url), opted.url);
      await page.waitForSelector("[data-app-origin-unknown]", { timeout: 10_000 });
      await page.waitForSelector("[data-app-silent]", { timeout: 10_000 });
      assert.equal(await page.$("[data-app-origin]"), null);

      // A page that refuses every frame never loads there.
      await page.goto(`${web.url}#/apps?url=${encodeURIComponent(refusing.url)}`);
      await page.waitForSelector("[data-app-silent]", { timeout: 10_000 });
      assert.equal(await page.$("[data-app-origin]"), null);
    } finally {
      await session.close();
      await Promise.all([demo.close(), opted.close(), refusing.close()]);
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
