// The web build under its HTTP CSP: a dedicated Worker and IndexedDB, without an extension.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import {
  ABANDON, BROWSERS, ROOT, WALLET_PASSWORD, answerIn, approvalIn, homeSettled,
  importWallet, launchWebWallet, serveFlushEsplora, serveL1Esplora, serveWebWallet,
} from "../harness.mjs";

const wallet = await importWallet();
const core = path.join(ROOT, "e2e", "dist", "core");
const vault = await wallet.loadVaultModule(await readFile(path.join(core, "vault.wasm")));
const flush = await wallet.loadChainModule(await readFile(path.join(core, "flush.wasm")));
const receive = flush.deriveAccount(vault.starter(ABANDON, "", 99), { receive: 1 }).receive[0];
const PAY_TO = flush.deriveAccount("blush cream bullet drive index disease noble east target dice put rate", { receive: 1 }).receive[0].address;
// Two coins: one for the hosted Send, one for the route approval, without indexing change.
const FUNDING = encodeTx({
  inputs: [{ txid: "e1".repeat(32), vout: 0 }],
  outputs: [0, 1].map(() => ({ value: 250_000, script: receive.scriptPubkey })),
});
// `cors`: the web build's pages reach the stubs as plain pages, not through host_permissions.
const L1 = { cors: true, identityBlock: { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" }, utxos: {} };
const flushConfig = () => ({
  cors: true,
  identityBlock: flush.chainEntry().networks.betanet.identityBlock,
  tipHeight: 10_000,
  feeEstimates: { 1: 1, 6: 0.1, 1008: 0.1 },
  txs: [{ hex: FUNDING, blockHeight: 3200 }],
  utxos: { [receive.address]: [0, 1].map((vout) => ({ txid: parseTx(FUNDING).txid, vout, value: 250_000, confirmed: true, blockHeight: 3200 })) },
});

/**
 * Navigates as an in-app link does. Assigning `location.hash` would bypass SvelteKit's router and
 * load the document again, which ends the Worker and with it the unlocked session.
 */
async function route(page, hash) {
  await page.evaluate((value) => {
    window.sameDocument = true;
    const link = Object.assign(document.createElement("a"), { href: value });
    document.body.append(link);
    link.click();
    link.remove();
  }, hash);
  await page.waitForFunction((value) => location.hash === value, {}, hash);
  assert.equal(await page.evaluate(() => window.sameDocument), true, "the route changed without reloading the page");
}

async function unlock(page) {
  await page.type("[data-password]", WALLET_PASSWORD);
  await page.click("[data-unlock]");
  await page.waitForSelector('[data-vault-state="unlocked"]');
  await homeSettled(page);
}

// Observe the page's real Worker, so an unhosted wallet request exercises openApproval as well
// as the Send form's hosted approval. Negative ids cannot collide with the transport's ids.
async function watchWorker(page) {
  await page.evaluateOnNewDocument(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        window.walletWorker = this;
        this.addEventListener("error", (event) => console.error(`Worker error: ${event.message}`));
      }
    };
    let id = 0;
    window.walletRequest = (message) => new Promise((resolve) => {
      const requestId = --id;
      const listener = ({ data }) => {
        if (data.type !== "response" || data.id !== requestId) return;
        window.walletWorker.removeEventListener("message", listener);
        resolve(data.response);
      };
      window.walletWorker.addEventListener("message", listener);
      window.walletWorker.postMessage({ type: "request", id: requestId, message });
    });
  });
}

for (const browserName of BROWSERS) describe(`${browserName}: web`, () => {
  let web;
  let l1;
  let stub;
  const config = flushConfig();
  before(async () => {
    web = await serveWebWallet();
    l1 = await serveL1Esplora(L1);
    stub = await serveFlushEsplora(config);
  });
  after(async () => {
    await stub?.close();
    await l1?.close();
    await web?.close();
  });

  async function withPage(run) {
    const session = await launchWebWallet(browserName);
    try {
      const page = await session.browser.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" || /content.security.policy|violat.*(?:directive|policy)|refused to (?:load|connect|execute)/i.test(message.text())) errors.push(message.text());
      });
      await page.evaluateOnNewDocument(() => {
        document.addEventListener("securitypolicyviolation", (event) => console.error(`CSP violation: ${event.violatedDirective} ${event.blockedURI}`));
      });
      await watchWorker(page);
      await run(page, session);
      assert.deepEqual(errors, [], "no page errors, Worker console errors or CSP violations during the flow");
    } finally {
      await session.close();
    }
  }

  async function open(page, hash) {
    const response = await page.goto(`${web.url}${hash}`);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["content-security-policy"], web.headers["Content-Security-Policy"]);
    await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  }

  test("create, lock, unlock and reload: the vault persists but the unlocked session does not", () => withPage(async (page) => {
    await open(page, "#/create");
    await page.waitForSelector("[data-word]");
    const words = await page.$$eval("[data-word]", (nodes) => nodes.map((e) => e.textContent.trim()));
    await page.click("[data-phrase-saved]");
    await page.waitForSelector("[data-confirm-word]");
    const positions = await page.$$eval("[data-confirm-word]", (nodes) => nodes.map((e) => Number(e.getAttribute("data-confirm-word"))));
    for (const n of positions) await page.type(`[data-confirm-word="${n}"]`, words[n - 1]);
    await page.type("[data-new-password]", WALLET_PASSWORD);
    await page.type("[data-repeat-password]", WALLET_PASSWORD);
    await page.click("[data-submit]");
    await page.waitForSelector('[data-vault-state="unlocked"]');
    await homeSettled(page);
    await page.click("[data-lock]");
    await page.waitForSelector('[data-vault-state="locked"]');
    await unlock(page);
    const response = await page.reload();
    assert.equal(response.headers()["content-security-policy"], web.headers["Content-Security-Policy"]);
    await page.waitForSelector('[data-vault-state="locked"]');
    await unlock(page);
    // A new Worker decrypted the same vault from IndexedDB with the same password.
    await route(page, "#/create");
    await page.waitForSelector("[data-already-exists]");
  }));

  test("web chains and Send: hosted approval, approval route, rejection, and return to the previous route", () => withPage(async (page, session) => {
    Object.assign(config, flushConfig());
    await open(page, "#/import");
    // Content-Type forces a preflight on this cross-origin read.
    assert.equal(await page.evaluate(async () => {
      const response = await fetch("http://127.0.0.1:24000/blocks/tip/height", { headers: { "Content-Type": "application/json" } });
      return response.text();
    }), String(L1.identityBlock.height));
    await page.type("[data-import-phrase]", ABANDON);
    await page.type("[data-new-password]", WALLET_PASSWORD);
    await page.type("[data-repeat-password]", WALLET_PASSWORD);
    await page.click("[data-submit]");
    await page.waitForSelector('[data-vault-state="unlocked"]');
    await homeSettled(page);
    assert.equal(await page.$("[data-pin], [data-unpin]"), null);
    assert.equal(await page.$('[data-account="24"]'), null);
    await route(page, "#/chains");
    await page.waitForSelector("[data-chains][data-screen-ready]");
    assert.deepEqual(await page.$$eval("[data-chain]", (nodes) => nodes.map((e) => e.getAttribute("data-chain"))), ["l1", "99"]);
    await page.click('[data-chain-switch="99"]');
    await page.waitForSelector('[data-chain-switch="99"][aria-checked="true"]');
    await route(page, "#/");
    await page.waitForSelector('[data-vault-state="unlocked"]');
    await homeSettled(page);
    assert.equal(await page.$("[data-pin], [data-unpin]"), null);
    await page.click("[data-send-action]");
    await page.waitForSelector("[data-send-sheet]");
    assert.equal(await page.$('[data-send-link="24"]'), null);
    await page.click('[data-send-link="99"]');
    await page.waitForSelector('[data-send-asset] option[value=""]', { timeout: 20_000 });
    await page.type("[data-send-amount]", "0.0001");
    await page.type("[data-send-destination]", PAY_TO);
    const count = stub.broadcasts().length;
    await page.click("[data-send-submit]");
    await approvalIn(page, { timeout: 20_000 });
    await answerIn(page, "[data-approve]");
    await page.waitForSelector("[data-send-done]", { timeout: 20_000 });
    assert.equal(stub.broadcasts().length, count + 1);
    assert.equal(await page.$eval("[data-send-txid]", (e) => e.getAttribute("data-send-txid")), parseTx(stub.broadcasts().at(-1)).txid);

    await route(page, "#/chains");
    await page.waitForSelector("[data-chains][data-screen-ready]");
    const leaving = page.evaluate((to) => window.walletRequest({ kind: "send.start", slot: 99, outputs: [{ asset: "", amount: "10000", to: { address: to } }] }), PAY_TO);
    await page.waitForFunction(() => /^#\/approve\/[^/]+$/.test(location.hash), { timeout: 20_000 });
    await approvalIn(page, { timeout: 20_000 });
    const beforeLeaving = stub.broadcasts().length;
    await route(page, "#/approve/not-pending");
    await page.waitForSelector("[data-approval-missing]");
    assert.equal(await page.$("[data-approve]"), null, "changing approval ids must discard the previous prompt");
    const cancelled = await leaving;
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error.code, 4001);
    assert.equal(stub.broadcasts().length, beforeLeaving);
    await route(page, "#/chains");
    await page.waitForSelector("[data-chains][data-screen-ready]");
    for (const approved of [false, true]) {
      const before = stub.broadcasts().length;
      const sending = page.evaluate((to) => window.walletRequest({ kind: "send.start", slot: 99, outputs: [{ asset: "", amount: "10000", to: { address: to } }] }), PAY_TO);
      await page.waitForFunction(() => /^#\/approve\/[^/]+$/.test(location.hash), { timeout: 20_000 });
      await approvalIn(page, { timeout: 20_000 });
      assert.match(await page.$eval("[data-origin]", (e) => e.textContent), /This wallet/);
      assert.equal(await page.$eval("[data-output] [data-destination]", (e) => e.textContent.trim()), PAY_TO);
      await page.click(approved ? "[data-approve]" : "[data-reject]");
      const answer = await sending;
      assert.equal(answer.ok, approved);
      if (approved) assert.equal(answer.result.txid, parseTx(stub.broadcasts().at(-1)).txid);
      else assert.equal(answer.error.code, 4001);
      await page.waitForFunction(() => location.hash === "#/chains");
      await page.waitForSelector("[data-chains][data-screen-ready]");
      assert.equal(stub.broadcasts().length, before + Number(approved));
    }
    assert.equal((await session.browser.pages()).filter((p) => p.url().includes("#/approve/")).length, 0);
  }));

  test("the HTTP CSP blocks inline script execution", async () => {
    const session = await launchWebWallet(browserName);
    try {
      const page = await session.browser.newPage();
      await open(page, "#/");
      const violation = await page.evaluate(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("No inline-script CSP violation within 10 seconds")), 10_000);
        document.addEventListener("securitypolicyviolation", (event) => {
          clearTimeout(timer);
          resolve({ directive: event.effectiveDirective, blocked: event.blockedURI });
        }, { once: true });
        const script = document.createElement("script");
        script.textContent = "window.inlineScriptRan = true";
        document.head.append(script);
      }));
      assert.match(violation.directive, /^script-src/);
      assert.equal(violation.blocked, "inline");
      assert.equal(await page.evaluate(() => window.inlineScriptRan), undefined);
    } finally {
      await session.close();
    }
  });
});
