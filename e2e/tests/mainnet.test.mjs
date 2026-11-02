// Seam 1, mainnet (#32): the network the wallet ships for, on servers tests control. The mainnet e2e
// build (`pnpm build:e2e:mainnet`) is the shipped build with eCash's and Flush's mainnet servers on
// the same loopback stubs as the betanet one, so what differs between networks is checked end to
// end: eCash and Flush (Slot 46) only, Flush's `flx` addresses, mainnet's replay nLockTime
// (499999998), Slot 46's Treasury and activation, the chains named in approvals and to apps, and a
// betanet server refused. Every other test runs on betanet (docs/testing.md).
//
// The wallet imports "abandon … about"; its addresses are derived here by the mainnet build's own
// vault.wasm, l1.wasm and flush.wasm. Every transaction is made here, from made-up inputs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { addressScript, encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import {
  ABANDON,
  activitySettled,
  answerIn,
  approvalIn,
  BROWSERS,
  DIST_E2E_MAINNET,
  homeSettled,
  importWallet,
  launchWallet,
  openTestApp,
  openWalletPage,
  relock,
  serveFlushEsplora,
  serveL1Esplora,
  serveTestApp,
  setUpWallet,
  turnOnChain,
  waitForFunction,
} from "../harness.mjs";

const SLOT = 46;
const wallet = await importWallet();
const wasm = (file) => readFile(path.join(DIST_E2E_MAINNET.chromium, file));
const [vault, l1, flush] = await Promise.all([
  wasm("vault.wasm").then(wallet.loadVaultModule),
  wasm("l1.wasm").then(wallet.loadL1Module),
  wasm("flush.wasm").then(wallet.loadChainModule),
]);
const L1_ENTRY = l1.chainEntry().networks.mainnet;
const FLUSH_ENTRY = flush.chainEntry().networks.mainnet;
const L1_ACCOUNT = l1.deriveAccount(vault.l1AccountKey(ABANDON, ""), { receive: 1, change: 1 });
const L1_RECEIVE_0 = L1_ACCOUNT.receive[0].address;
const L1_CHANGE_0 = L1_ACCOUNT.change[0].address;
const RECEIVE_0 = flush.deriveAccount(vault.starter(ABANDON, "", SLOT), { receive: 1 }).receive[0];
const PAY_TO = flush.deriveAccount("blush cream bullet drive index disease noble east target dice put rate", { receive: 1 }).receive[0].address;
/** Someone else's eCash address (BIP173's example P2WPKH). */
const L1_PAY_TO = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
/** Slot 46's Treasury on mainnet: `OP_NOP8 <46> OP_TRUE`. */
const TREASURY = "b7012e51";

/** Two coins on eCash, so a Deposit and a Send each have one the other doesn't hold. */
const funding = (seed, value) => {
  const hex = encodeTx({ inputs: [{ txid: seed.repeat(32), vout: 0 }], outputs: [{ value, script: addressScript(L1_RECEIVE_0) }] });
  return { hex, txid: parseTx(hex).txid, confirmed: true, blockHeight: 980_000 };
};
const COINS = [funding("f0", 250_000), funding("f1", 200_000)];

/** What eCash's stub holds (read on every request). */
const L1 = {
  identityBlock: L1_ENTRY.identityBlock,
  blocks: { [FLUSH_ENTRY.activation.height]: FLUSH_ENTRY.activation.hash },
  tipHeight: 981_000,
  feeEstimates: { 1: 0.97, 6: 2, 1008: 0.1 },
  txs: COINS,
  utxos: { [L1_RECEIVE_0]: COINS.map((c) => ({ txid: c.txid, vout: 0, value: parseTx(c.hex).outputs[0].value, confirmed: true })) },
  addressTxCounts: {},
};

const FINAL = "f0".repeat(32);
/** 0.001 ECX paid to the wallet's Slot 46 address by a Deposit, in a coinbase. */
const PAYOUT = encodeTx({
  inputs: [{ txid: "00".repeat(32), vout: 0xffffffff, script: "03e40c00" }],
  outputs: [{ value: 0, script: "" }, { value: 100_000, script: RECEIVE_0.scriptPubkey }],
});

/** What Flush's stub holds (read on every request). */
const FLUSH = {
  identityBlock: FLUSH_ENTRY.identityBlock,
  tipHeight: 8_000,
  feeEstimates: { 1: 1, 6: 0.1, 1008: 0.1 },
  finality: {},
  txs: [{ hex: PAYOUT, blockHeight: 7_000, blockHash: FINAL }],
  utxos: { [RECEIVE_0.address]: [{ txid: parseTx(PAYOUT).txid, vout: 1, value: 100_000, confirmed: true, blockHash: FINAL }] },
};

/** What an approval shown in place reviews. */
const readReview = (approval) =>
  approval.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return {
      origin: text(document.querySelector("[data-origin]")),
      chain: text(document.querySelector("[data-chain]")),
      deposit: text(document.querySelector("[data-deposit]")),
      destinations: [...document.querySelectorAll("[data-output] [data-destination]")].map(text),
    };
  });

/** A home card's error, once its chain has been read. */
async function cardError(session, account) {
  const page = await session.openPage("index.html#/");
  const card = `[data-account="${account}"]`;
  await page.waitForSelector(`${card}:not([data-refreshing]) :is([data-balance], [data-no-balance], [data-balance-error])`, { timeout: 20_000 });
  const error = await page.$eval(card, (e) => e.querySelector("[data-balance-error]")?.textContent.replace(/\s+/g, " ").trim());
  await homeSettled(page);
  await page.close();
  return error;
}

test("the mainnet build's modules serve mainnet, Flush as Slot 46", () => {
  assert.equal(l1.declare().binding.chain, "ecash:mainnet");
  assert.equal(flush.declare().binding.chain, "ecash:mainnet-s46");
  assert.equal(FLUSH_ENTRY.slot, SLOT);
  assert.equal(l1.treasuryScript(SLOT), TREASURY);
  assert.match(RECEIVE_0.address, /^flx1/);
});

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let l1Stub;
  let flushStub;
  let app;
  before(async () => {
    [session, l1Stub, flushStub, app] = await Promise.all([
      launchWallet(browserName, { build: "e2e-mainnet" }),
      serveL1Esplora(L1),
      serveFlushEsplora(FLUSH),
      serveTestApp(),
    ]);
    await setUpWallet(session, { on: [] }); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
    await l1Stub?.close();
    await flushStub?.close();
    await app?.close();
  });

  test("the Chains screen lists eCash and Flush as Slot 46, and nothing else", async () => {
    const page = await openWalletPage(session, "#/chains");
    const rows = await page.$$eval("[data-chain]", (rows) =>
      rows.map((r) => [r.getAttribute("data-chain"), r.querySelector("[data-always-on]") ? "always" : r.querySelector("[role=switch]").getAttribute("aria-checked")]),
    );
    assert.deepEqual(rows, [["l1", "always"], [String(SLOT), "false"]]);
    await turnOnChain(page, SLOT);
    await page.close();
  });

  test("home reads both chains from their mainnet servers, Flush's ECX included", async () => {
    const page = await session.openPage("index.html#/");
    await homeSettled(page);
    const shown = await page.evaluate((slot) => {
      const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
      const card = (account) => document.querySelector(`[data-account="${account}"]`);
      return {
        l1: text(card("l1").querySelector('[data-balance][data-asset=""]')),
        flush: text(card(slot).querySelector('[data-balance][data-asset=""]')),
        errors: [...document.querySelectorAll("[data-balance-error]")].map(text),
      };
    }, SLOT);
    assert.deepEqual(shown, { l1: "0.0045 ECX", flush: "0.001 ECX", errors: [] });
    assert.equal(l1Stub.requests()[0], `/block-height/${L1_ENTRY.identityBlock.height}`, "eCash's mainnet fork block is checked first");
    assert.ok(flushStub.requests().includes("/block-height/0"), "Flush's genesis is checked");
    await page.close();
  });

  test("Receive shows Flush's mainnet address, in flx… encoding", async () => {
    const page = await session.openPage("index.html#/");
    // Settled first: the sheet's rows carry `data-account` too, and never Deposits.
    await homeSettled(page);
    await page.click("[data-receive-action]");
    const row = `[data-receive-sheet] [data-account="${SLOT}"]`;
    await page.waitForSelector(`${row} [data-qr-toggle]`, { timeout: 20_000 });
    await page.click(`${row} [data-qr-toggle]`);
    await page.waitForSelector(`${row} [data-qr]`);
    assert.equal(await page.$eval(`${row} [data-receive-address]`, (e) => e.textContent.trim()), RECEIVE_0.address);
    assert.equal(await page.$eval(`${row} [data-account-chain]`, (e) => e.textContent.trim()), "ecash:mainnet-s46");
    await page.close();
  });

  test("a first Deposit to Slot 46 checks its activation, and goes out as a mainnet M5", async () => {
    const page = await openWalletPage(session, `#/deposit/${SLOT}`);
    await page.waitForSelector("[data-deposit-available]", { timeout: 20_000 });
    await waitForFunction(page, () => document.querySelector("[data-deposit-scanning]") === null, { timeout: 20_000 });
    await page.type("[data-deposit-amount]", "0.0005");
    await page.click("[data-deposit-submit]");
    await page.waitForSelector("[data-approval-ready], [data-error]", { timeout: 20_000 });
    assert.equal(await page.$eval("[data-error]", (e) => e.textContent.trim()).catch(() => null), null);
    const approval = await approvalIn(page);
    const review = await readReview(approval);
    assert.equal(review.chain, "ecash:mainnet");
    assert.match(review.deposit, new RegExp(`^Deposit 0\\.0005 ECX to Slot ${SLOT} \\(Flush\\)\\..*${RECEIVE_0.address}`));
    assert.match(await approval.$eval("[data-treasury]", (e) => e.textContent.replace(/\s+/g, " ")), /Treasury: 0 ECX → 0\.0005 ECX/);
    await answerIn(approval, "[data-approve]");
    await page.waitForSelector("[data-deposit-done], [data-error]", { timeout: 20_000 });
    assert.equal(await page.$eval("[data-error]", (e) => e.textContent).catch(() => null), null);
    assert.ok(l1Stub.requests().includes(`/block-height/${FLUSH_ENTRY.activation.height}`), "Slot 46's activation block is checked");

    const m5 = parseTx(l1Stub.broadcasts().at(-1));
    assert.equal(m5.locktime, 499999998, "mainnet's replay nLockTime");
    assert.ok(m5.inputs.every((i) => i.sequence === 0xfffffffd), "non-final nSequence on every input");
    assert.deepEqual(m5.outputs[0], { value: 50_000, script: TREASURY }, "Slot 46's Treasury");
    assert.match(m5.outputs[1].script, /^6a/, "the address the Deposit is credited to");
    await page.close();
  });

  test("Send on eCash is reviewed as ecash:mainnet and replay-marked for mainnet", async () => {
    const page = await openWalletPage(session, "#/send/l1");
    await page.waitForSelector('[data-send-asset] option[value=""]', { timeout: 20_000 });
    await page.type('[data-send-row="0"] [data-send-amount]', "0.0004");
    await page.type('[data-send-row="0"] [data-send-destination]', L1_PAY_TO);
    const before = l1Stub.broadcasts().length;
    await page.click("[data-send-submit]");
    const approval = await approvalIn(page, { timeout: 20_000 });
    await approval.waitForSelector("[data-output]");
    const review = await readReview(approval);
    assert.deepEqual([review.origin, review.chain, review.destinations], ["This wallet (Send on Main chain)", "ecash:mainnet", [L1_PAY_TO, L1_CHANGE_0]]);
    await answerIn(approval, "[data-approve]");
    await page.waitForSelector("[data-send-done], [data-error]", { timeout: 20_000 });
    assert.equal(await page.$eval("[data-error]", (e) => e.textContent).catch(() => null), null);
    assert.equal(l1Stub.broadcasts().length, before + 1);
    const tx = parseTx(l1Stub.broadcasts().at(-1));
    assert.equal(tx.locktime, 499999998, "mainnet's replay nLockTime");
    assert.deepEqual(tx.outputs[0], { value: 40_000, script: addressScript(L1_PAY_TO) });
    await page.close();
  });

  test("Send on Flush is reviewed as ecash:mainnet-s46 and broadcast to Flush's server", async () => {
    const page = await openWalletPage(session, `#/send/${SLOT}`);
    await page.waitForSelector('[data-send-asset] option[value=""]', { timeout: 20_000 });
    await page.type('[data-send-row="0"] [data-send-amount]', "0.0004");
    await page.type('[data-send-row="0"] [data-send-destination]', PAY_TO);
    await page.click("[data-send-submit]");
    const approval = await approvalIn(page, { timeout: 20_000 });
    await approval.waitForSelector("[data-output]");
    const review = await readReview(approval);
    assert.deepEqual([review.origin, review.chain, review.destinations[0], review.destinations.length], ["This wallet (Send on Flush)", "ecash:mainnet-s46", PAY_TO, 2]);
    await answerIn(approval, "[data-approve]");
    await page.waitForSelector("[data-send-done], [data-error]", { timeout: 20_000 });
    assert.equal(await page.$eval("[data-error]", (e) => e.textContent).catch(() => null), null);
    const tx = parseTx(flushStub.broadcasts().at(-1));
    assert.deepEqual(tx.inputs.map((i) => i.txid), [parseTx(PAYOUT).txid]);
    assert.equal(tx.outputs[0].value, 40_000);
    await page.click("[data-send-activity]");
    await page.waitForSelector('[data-tab="activity"][aria-selected="true"]', { timeout: 10_000 });
    await activitySettled(page);
    await page.close();
  });

  test("a Sidechain App connects to Slot 46 and gets its flx address; window.flush names the network ecash", async () => {
    const page = await openTestApp(session, app, "mainnet.localhost");
    const connecting = page.evaluate((slot) => window.testApp.request("connect", { slots: [slot], methods: ["getAddresses"] }), SLOT);
    await (await session.waitForApprovalWindow()).click("[data-approve]");
    assert.ok((await connecting).result, "connected");
    const answer = await page.evaluate((slot) => window.testApp.request("getAddresses", { slot }), SLOT);
    assert.equal(answer.result?.[0]?.address, RECEIVE_0.address);
    await page.close();

    const dex = await openTestApp(session, app, "dex.localhost");
    const asking = dex.evaluate(() => window.flush.request({ method: "flush_requestAddress" }));
    await (await session.waitForApprovalWindow()).click("[data-approve]");
    assert.deepEqual(await asking, { network: "ecash", address: RECEIVE_0.address });
    await dex.close();
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });

  test("betanet's servers are refused: Flush's genesis and eCash's fork block aren't mainnet's", async () => {
    const mainnet = { l1: L1.identityBlock, flush: FLUSH.identityBlock };
    // Flush's betanet genesis (Slot 99), and another block at mainnet's fork height.
    FLUSH.identityBlock = flush.chainEntry().networks.betanet.identityBlock;
    L1.identityBlock = { height: L1_ENTRY.identityBlock.height, hash: "11".repeat(32) };
    await relock(session); // the wallet checks a server's chain once per session
    try {
      assert.match(await cardError(session, SLOT), new RegExp(`another chain: its genesis block is ${FLUSH.identityBlock.hash.slice(0, 8)}`));
      assert.match(await cardError(session, "l1"), new RegExp(`another chain: its block ${L1_ENTRY.identityBlock.height} is ${"11".repeat(32)}`));
    } finally {
      L1.identityBlock = mainnet.l1;
      FLUSH.identityBlock = mainnet.flush;
    }
  });
});
