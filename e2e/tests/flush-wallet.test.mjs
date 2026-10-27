// Seam 1, Flush (Slot 99 on betanet, #56): the e2e build's wallet reads Flush from the Esplora stub in Flush
// mode, listening where that build's Chain Entry names betanet's server, and sends ECX on it. The
// logic's edge cases are in node, in flush.test; this is what the user sees.
//
// The wallet imports "abandon … about"; its Slot 99 Starter and addresses are derived here by the
// shipped vault.wasm and flush.wasm. No plain ECX transfer exists on the live chain, so every
// fixture is made here: a Deposit's payout in a coinbase, someone's payment, a token's output.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import {
  ABANDON,
  activitySettled,
  answerIn,
  approvalIn,
  BROWSERS,
  DIST,
  homeSettled,
  importWallet,
  launchWallet,
  openTestApp,
  openWalletPage,
  ROOT,
  serveFlushEsplora,
  serveL1Esplora,
  serveTestApp,
  setUpWallet,
} from "../harness.mjs";

const wallet = await importWallet();
const [vault, flush] = await Promise.all([
  readFile(path.join(DIST.chromium, "vault.wasm")).then(wallet.loadVaultModule),
  readFile(path.join(DIST.chromium, "flush.wasm")).then(wallet.loadChainModule),
]);
const account = flush.deriveAccount(vault.starter(ABANDON, "", 99), { receive: 1 });
const RECEIVE_0 = account.receive[0];
const PAY_TO = flush.deriveAccount("blush cream bullet drive index disease noble east target dice put rate", { receive: 1 }).receive[0].address;

const SOFT = "50".repeat(32);
const FINAL = "f0".repeat(32);

/** 0.001 ECX paid to the wallet by a Deposit, in a coinbase. */
const PAYOUT = encodeTx({
  inputs: [{ txid: "00".repeat(32), vout: 0xffffffff, script: "03e40c00" }],
  outputs: [{ value: 0, script: "" }, { value: 100_000, script: RECEIVE_0.scriptPubkey }],
});
/** Someone's 0.00005 ECX to the wallet, in a block not yet anchored: preconf. */
const PAYMENT = encodeTx({ inputs: [{ txid: "e1".repeat(32), vout: 0 }], outputs: [{ value: 5_000, script: RECEIVE_0.scriptPubkey }] });
/** A token's output at the wallet's address: value 0. */
const TOKEN = encodeTx({ inputs: [{ txid: "e2".repeat(32), vout: 0 }], outputs: [{ value: 0, script: RECEIVE_0.scriptPubkey }] });

/** BROSEVELT, a live Slot 99 asset: its registration and SetLogo (core/flush/tests/token-txs.json). */
const BROSEVELT = "7351ccd9fd2f091cce3f9d8e3cd0b95f278885f4610620784b8c64be8b0237c1";
const LIVE_TXS = JSON.parse(await readFile(path.join(ROOT, "core/flush/tests/token-txs.json"), "utf8"));
const REGISTRATION = "24fc101fccc71bc60845e190c2ad1e07b332fe7a6de99af37acdaaefdd9db891";
const LOGO = "7958bc9b161e2bacc98e66bd7c6a01457809817a4c0cfcecc749504ad38e8d44";
/** 10 BROSEVELT (1,000 units at 2 decimals) to the wallet: a transfer whose marker lists output 0. */
const BROSEVELT_IN = encodeTx({
  inputs: [{ txid: "e3".repeat(32), vout: 0 }],
  outputs: [
    { value: 0, script: RECEIVE_0.scriptPubkey },
    // OP_RETURN "BAST" v0 transfer, one listed output: n 0, an asset token, its id (internal order), VARINT 1000.
    { value: 0, script: `6a2b${Buffer.from("BAST").toString("hex")}00000100${"00"}${Buffer.from(BROSEVELT, "hex").reverse().toString("hex")}8668` },
  ],
});

/** A ClaimLaunch (kind 23) whose result output pays the wallet: what it carries only the node knows. */
const CLAIM = encodeTx({
  inputs: [{ txid: "e5".repeat(32), vout: 0 }],
  outputs: [
    { value: 0, script: RECEIVE_0.scriptPubkey },
    // OP_RETURN "BAST" v0 kind 23, a 32-byte field, one listed output: n 0, a result (0xff).
    { value: 0, script: `6a29${Buffer.from("BAST").toString("hex")}0017${"cd".repeat(32)}0100ff` },
  ],
});

/** FORK, a live launch on Slot 99: its registration and its launch's pool, as getpool answers (core/flush/tests). */
const TRADE = JSON.parse(await readFile(path.join(ROOT, "core/flush/tests/trade-fixtures.json"), "utf8"));
const FORK = "6bb2ae6e23e626cd2fba1f8845d8bbc047aeb9a8f4690ee9a21b5d04584dfb03";
const FORK_POOL = "2b16f8c06c0f98034bacfe23cec9e36ce96b3d1282766dd957901435354b402a";
/** 0.0005 ECX to the wallet, for the trade alone. */
const FOR_TRADE = encodeTx({ inputs: [{ txid: "e4".repeat(32), vout: 0 }], outputs: [{ value: 50_000, script: RECEIVE_0.scriptPubkey }] });

const utxo = (hex, value, blockHash) => ({ txid: parseTx(hex).txid, vout: hex === PAYOUT ? 1 : 0, value, confirmed: true, blockHash });

/** What the Flush stub holds (read on every request). */
const FLUSH = {
  identityBlock: flush.chainEntry().networks.betanet.identityBlock,
  tipHeight: 3300,
  feeEstimates: { 1: 1, 6: 0.1, 1008: 0.1 },
  finality: { [SOFT]: "soft" },
  txs: [
    { hex: PAYOUT, blockHeight: 3200, blockHash: FINAL },
    { hex: PAYMENT, blockHeight: 3299, blockHash: SOFT },
    { hex: TOKEN, blockHeight: 3250, blockHash: FINAL },
  ],
  utxos: { [RECEIVE_0.address]: [utxo(PAYOUT, 100_000, FINAL), utxo(PAYMENT, 5_000, SOFT), utxo(TOKEN, 0, FINAL)] },
};

const L1_ESPLORA = { identityBlock: { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" }, utxos: {} };

/** Home, unlocked, once every chain's fresh report is in. */
async function openHome(session) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector('[data-vault-state="unlocked"]', { timeout: 10_000 });
  await homeSettled(page);
  return page;
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let stub;
  let l1Stub;
  let app;
  before(async () => {
    [session, stub, l1Stub, app] = await Promise.all([launchWallet(browserName), serveFlushEsplora(FLUSH), serveL1Esplora(L1_ESPLORA), serveTestApp()]);
    await setUpWallet(session, { on: [99] });
  });
  after(async () => {
    await session?.close();
    await stub?.close();
    await l1Stub?.close();
    await app?.close();
  });

  test("home shows Flush's ECX, its soft block's payment counted and marked preconf", async () => {
    const page = await openHome(session);
    const shown = await page.evaluate(() => {
      const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
      const card = document.querySelector('[data-account="99"]');
      return {
        name: text(card.querySelector("[data-chain-link] strong")),
        balance: text(card.querySelector('[data-balance][data-asset=""]')),
        preconf: text(card.querySelector('[data-preconfirmed][data-asset=""]')),
        unconfirmed: card.querySelector('[data-unconfirmed][data-asset=""]') !== null,
        stalled: card.querySelector("[data-stalled]") !== null,
      };
    });
    assert.deepEqual(shown, { name: "Flush", balance: "0.00105 ECX", preconf: "0.00005 ECX preconf", unconfirmed: false, stalled: false });
    await page.close();
  });

  test("Flush's Activity lists the Deposit's payout", async () => {
    const page = await openWalletPage(session, "#/chain/99/activity");
    await page.waitForSelector(`[data-history-entry="${parseTx(PAYOUT).txid}"]`, { timeout: 20_000 });
    await activitySettled(page);
    await page.close();
  });

  test("Send on Flush: built from the wallet's ECX, reviewed in place, broadcast, and shown with its txid", async () => {
    const page = await openWalletPage(session, "#/send/99");
    await page.waitForSelector('[data-send-asset] option[value=""]', { timeout: 20_000 });
    const option = await page.$eval('[data-send-row="0"] [data-send-asset] option[value=""]', (e) => e.textContent.trim());
    assert.equal(option, "ECX (0.00105 ECX spendable)", "someone's payment in a soft block (preconf) included");

    await page.type('[data-send-row="0"] [data-send-amount]', "0.0004");
    await page.type('[data-send-row="0"] [data-send-destination]', PAY_TO);
    const before = stub.broadcasts().length;
    await page.click("[data-send-submit]");

    const approval = await approvalIn(page, { timeout: 20_000 });
    await approval.waitForSelector("[data-output]");
    const review = await approval.evaluate(() => ({
      origin: document.querySelector("[data-origin]").textContent.trim(),
      destinations: [...document.querySelectorAll("[data-output] [data-destination]")].map((e) => e.textContent.trim()),
    }));
    assert.equal(review.origin, "This wallet (Send on Flush)");
    assert.equal(review.destinations[0], PAY_TO);
    assert.equal(review.destinations.length, 2, "and change");
    await answerIn(approval, "[data-approve]");

    await page.waitForSelector("[data-send-done], [data-error]", { timeout: 20_000 });
    assert.equal(await page.$eval("[data-error]", (e) => e.textContent).catch(() => null), null);
    assert.equal(stub.broadcasts().length, before + 1);
    const tx = parseTx(stub.broadcasts().at(-1));
    assert.equal(await page.$eval("[data-send-txid]", (e) => e.getAttribute("data-send-txid")), tx.txid);
    assert.deepEqual(tx.inputs.map((i) => i.txid), [parseTx(PAYOUT).txid], "never the token's output");
    assert.equal(tx.locktime, 0);
    assert.equal(tx.outputs[0].value, 40_000);

    await page.click("[data-send-activity]");
    await page.waitForSelector('[data-tab="activity"][aria-selected="true"]', { timeout: 10_000 });
    await activitySettled(page);
    await page.close();
  });

  test("a Flush with no block for 5 minutes shows as stalled, on home and on its screen", async () => {
    FLUSH.tipTime = Math.floor(Date.now() / 1000) - 3600;
    try {
      const home = await openHome(session);
      assert.notEqual(await home.$('[data-account="99"] [data-stalled]'), null);
      await home.close();

      const page = await openWalletPage(session, "#/chain/99");
      await page.waitForSelector("[data-settled]", { timeout: 20_000 });
      const notice = await page.$eval("[data-stalled]", (e) => e.textContent.trim());
      assert.match(notice, /^Flush has made no block since .+\. Nothing sent on it confirms until it moves again\.$/);
      await page.close();
    } finally {
      FLUSH.tipTime = undefined;
    }
  });

  test("home names a token from its registration by itself, with the logo its SetLogo carries", async () => {
    const txs = FLUSH.txs;
    const utxos = FLUSH.utxos[RECEIVE_0.address];
    FLUSH.txs = [
      ...txs,
      { hex: BROSEVELT_IN, blockHeight: 3260, blockHash: FINAL },
      { hex: LIVE_TXS[REGISTRATION], blockHeight: 604, blockHash: FINAL },
      { hex: LIVE_TXS[LOGO], blockHeight: 8462, blockHash: FINAL },
    ];
    FLUSH.utxos[RECEIVE_0.address] = [...utxos, utxo(BROSEVELT_IN, 0, FINAL)];
    FLUSH.flushAssets = { [BROSEVELT]: { asset: BROSEVELT, registered: 604, registration: REGISTRATION, logo: { height: 8462, txid: LOGO } } };
    try {
      const page = await openHome(session);
      const row = `[data-account="99"] li[data-asset="${BROSEVELT}"]`;
      await page.waitForSelector(`${row} img`, { timeout: 20_000 });
      const shown = await page.$eval(row, (e) => ({
        ticker: e.querySelector(".name strong").textContent.trim(),
        balance: e.querySelector("[data-balance]").textContent.replace(/\s+/g, " ").trim(),
        logo: e.querySelector("img").getAttribute("src").slice(0, 27),
        loaded: e.querySelector("img").naturalWidth > 0,
        trust: e.querySelector("[data-asset-trust]")?.getAttribute("data-asset-trust"),
      }));
      // A registration proves only what the asset calls itself: anyone may register a free ticker (docs/adr/0015).
      assert.deepEqual(shown, { ticker: "BROSEVELT", balance: "10 BROSEVELT", logo: "data:image/jpeg;base64,/9j/", loaded: true, trust: "unverified" });
      assert.equal(await page.$(`[data-account="99"] li[data-asset=""] [data-asset-trust]`), null, "ECX carries eCash's mark, no badge");
      await page.close();
    } finally {
      FLUSH.txs = txs;
      FLUSH.utxos[RECEIVE_0.address] = utxos;
      FLUSH.flushAssets = undefined;
    }
  });

  test("Flush's Activity shows a token transfer's amount, and notes a result's as the node's alone", async () => {
    const txs = FLUSH.txs;
    FLUSH.txs = [
      ...txs,
      { hex: BROSEVELT_IN, blockHeight: 3260, blockHash: FINAL },
      { hex: CLAIM, blockHeight: 3270, blockHash: FINAL },
      { hex: LIVE_TXS[REGISTRATION], blockHeight: 604, blockHash: FINAL },
    ];
    FLUSH.flushAssets = { [BROSEVELT]: { asset: BROSEVELT, registered: 604, registration: REGISTRATION } };
    try {
      const page = await openWalletPage(session, "#/chain/99/activity");
      const row = (tx) => `[data-history-entry="${parseTx(tx).txid}"]`;
      await page.waitForSelector(`${row(BROSEVELT_IN)} [data-history-amount][data-asset="${BROSEVELT}"]`, { timeout: 20_000 });
      await activitySettled(page);
      const shown = await page.evaluate(
        (rows) =>
          rows.map((r) => {
            const e = document.querySelector(r);
            const text = (x) => x?.textContent.replace(/\s+/g, " ").trim();
            return { amounts: [...e.querySelectorAll("[data-history-amount]")].map(text), results: text(e.querySelector("[data-history-results]")) ?? null };
          }),
        [row(BROSEVELT_IN), row(CLAIM)],
      );
      assert.deepEqual(shown, [
        { amounts: ["+10 BROSEVELT"], results: null },
        { amounts: [], results: "+ amounts only the node knows not shown" },
      ]);
      await page.close();
    } finally {
      FLUSH.txs = txs;
      FLUSH.flushAssets = undefined;
    }
  });

  test("flush.markets finds the wallet at window.flush, gets its address once granted, and a buy is approved in a trade Clear View", async () => {
    const { txs, utxos } = { txs: FLUSH.txs, utxos: FLUSH.utxos[RECEIVE_0.address] };
    FLUSH.txs = [...txs, { hex: FOR_TRADE, blockHeight: 3260, blockHash: FINAL }, { hex: TRADE.forkRegistration.hex, blockHeight: 7790, blockHash: FINAL }];
    // Only this coin: earlier tests' spends may still hold the others.
    FLUSH.utxos[RECEIVE_0.address] = [utxo(FOR_TRADE, 50_000, FINAL)];
    FLUSH.flushAssets = { [FORK]: { asset: FORK, registered: 7790, registration: TRADE.forkRegistration.txid } };
    FLUSH.flushRpc = {
      getswapquote: () => ({ pools: [{ pool: FORK_POOL, curve: "launch", amount_out: 0.044482 }], best_pool: FORK_POOL }),
      getpool: ([id]) => (id === FORK_POOL ? TRADE.forkPool : undefined),
      getbitassetsinfo: { min_chn_payout: 0.00005, small_payout_height: 9000 },
    };
    try {
      const page = await openTestApp(session, app, "dex.localhost");
      assert.equal(await page.evaluate(() => window.flush?.isFlush), true);
      const asking = page.evaluate(() => window.flush.request({ method: "flush_requestAddress" }));
      const grant = await session.waitForApprovalWindow();
      assert.deepEqual(await grant.$$eval("[data-method]", (e) => e.map((m) => m.textContent.trim())), ["getAddresses", "sendTransfer"]);
      await grant.click("[data-approve]");
      assert.deepEqual(await asking, { network: "ecashbeta", address: RECEIVE_0.address });

      const link = `flush:buy?v=1&network=ecashbeta&exp=${Math.floor(Date.now() / 1000) + 600}&launch=FORK&asset=${FORK}&ecx=0.0001&min_tokens=0.044`;
      const before = stub.broadcasts().length;
      const submitting = page.evaluate(
        (uri) => window.flush.request({ method: "flush_submit", params: { uri } }).catch((e) => ({ code: e.code, message: e.message })),
        link,
      );
      const approval = await session.waitForApprovalWindow({ timeout: 20_000 });
      const shown = await approval.$eval("[data-trade]", (e) => {
        const text = (q) => e.querySelector(q)?.textContent.replace(/\s+/g, " ").trim();
        return { title: text("h2"), pay: text("[data-trade-pay]"), receive: text("[data-trade-receive]"), quote: text("[data-trade-quote]"), to: text("[data-trade-to]"), warnings: e.querySelectorAll("[data-trade-warning]").length };
      });
      assert.deepEqual(shown, {
        title: "Buy on Flush",
        pay: "Pay 0.00010000 ECX",
        receive: "Receive at least 0.044000 FORK",
        quote: "The pool gives 0.044482 FORK now, by the node's own quote.",
        to: RECEIVE_0.address,
        warnings: 0,
      });
      await approval.click("[data-approve]");
      const answer = await submitting;
      assert.equal(stub.broadcasts().length, before + 1);
      assert.deepEqual(answer, { txid: parseTx(stub.broadcasts().at(-1)).txid });
      assert.equal(stub.burnAllowances().at(-1), "0.0001");

      // The same link again: refused, with the reason for the site to show.
      const again = await page.evaluate((uri) => window.flush.request({ method: "flush_submit", params: { uri } }).catch((e) => ({ code: e.code, message: e.message })), link);
      assert.deepEqual(again, { code: -32602, message: "This link has already run: ask the site for a fresh one." });
      await page.close();
    } finally {
      FLUSH.txs = txs;
      FLUSH.utxos[RECEIVE_0.address] = utxos;
      FLUSH.flushAssets = FLUSH.flushRpc = undefined;
    }
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
