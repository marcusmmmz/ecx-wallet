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
import { ABANDON, activitySettled, BROWSERS, DIST, homeSettled, importWallet, launchWallet, openWalletPage, serveFlushEsplora, serveL1Esplora, setUpWallet } from "../harness.mjs";

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
/** Someone's 0.00005 ECX to the wallet, in a block not yet anchored. */
const PAYMENT = encodeTx({ inputs: [{ txid: "e1".repeat(32), vout: 0 }], outputs: [{ value: 5_000, script: RECEIVE_0.scriptPubkey }] });
/** A token's output at the wallet's address: value 0. */
const TOKEN = encodeTx({ inputs: [{ txid: "e2".repeat(32), vout: 0 }], outputs: [{ value: 0, script: RECEIVE_0.scriptPubkey }] });

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
  before(async () => {
    [session, stub, l1Stub] = await Promise.all([launchWallet(browserName), serveFlushEsplora(FLUSH), serveL1Esplora(L1_ESPLORA)]);
    await setUpWallet(session, { on: [99] });
  });
  after(async () => {
    await session?.close();
    await stub?.close();
    await l1Stub?.close();
  });

  test("home shows Flush's ECX, its soft block's payment apart as unconfirmed", async () => {
    const page = await openHome(session);
    const shown = await page.evaluate(() => {
      const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
      const card = document.querySelector('[data-account="99"]');
      return {
        name: text(card.querySelector("[data-chain-link] strong")),
        balance: text(card.querySelector('[data-balance][data-asset=""]')),
        unconfirmed: text(card.querySelector('[data-unconfirmed][data-asset=""]')),
        stalled: card.querySelector("[data-stalled]") !== null,
      };
    });
    assert.deepEqual(shown, { name: "Flush", balance: "0.001 ECX", unconfirmed: "+0.00005 ECX unconfirmed", stalled: false });
    await page.close();
  });

  test("Flush's Activity lists the Deposit's payout", async () => {
    const page = await openWalletPage(session, "#/chain/99/activity");
    await page.waitForSelector(`[data-history-entry="${parseTx(PAYOUT).txid}"]`, { timeout: 20_000 });
    await activitySettled(page);
    await page.close();
  });

  test("Send on Flush: built from the wallet's ECX, reviewed in the approval window, broadcast, and shown with its txid", async () => {
    const page = await openWalletPage(session, "#/send/99");
    await page.waitForSelector('[data-send-asset] option[value=""]', { timeout: 20_000 });
    const option = await page.$eval('[data-send-row="0"] [data-send-asset] option[value=""]', (e) => e.textContent.trim());
    assert.equal(option, "ECX (0.001 ECX spendable)", "anchored only: someone's payment in a soft block isn't spendable yet");

    await page.type('[data-send-row="0"] [data-send-amount]', "0.0004");
    await page.type('[data-send-row="0"] [data-send-destination]', PAY_TO);
    const before = stub.broadcasts().length;
    await page.click("[data-send-submit]");

    const approval = await session.waitForApprovalWindow({ timeout: 20_000 });
    await approval.waitForSelector("[data-output]");
    const review = await approval.evaluate(() => ({
      origin: document.querySelector("[data-origin]").textContent.trim(),
      destinations: [...document.querySelectorAll("[data-output] [data-destination]")].map((e) => e.textContent.trim()),
    }));
    assert.equal(review.origin, "This wallet (Send on Flush)");
    assert.equal(review.destinations[0], PAY_TO);
    assert.equal(review.destinations.length, 2, "and change");
    await approval.click("[data-approve]");

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

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
