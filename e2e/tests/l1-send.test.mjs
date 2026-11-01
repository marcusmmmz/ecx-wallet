// Seam 1, Send on the main chain (#40): the L1 module builds the wallet's own Send from its coins
// over eCash's Esplora, the L1 Decoder explains it in place, and it goes out signed and
// replay-marked. Its coins are held from the next Send and from a Deposit (one held list on the
// main chain), and its change is spendable at once: it's trusted.
//
// eCash's server is the stub Esplora server where the e2e build's Chain Entry names it, holding real
// raw transactions (made-up inputs), as in deposit.test.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { addressScript, encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import { answerIn, approvalIn, BROWSERS, homeSettled, launchWallet, openWalletPage, serveEsplora, serveL1Esplora, setUpWallet, waitForFunction } from "../harness.mjs";

const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const L1_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const L1_CHANGE_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
/** Slot 24's activation, as its Chain Entry pins it: a Deposit with no Treasury checks it. */
const ACTIVATION = { height: 970715, hash: "000000000000000094c4b58e192ea0105c5e82c3eaf168ab53090254bc9a3c3c" };
/** Someone else's eCash address (BIP173's example P2WPKH): it reads as a Bitcoin address too. */
const PAY_TO = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";

const FUNDING_HEX = encodeTx({ inputs: [{ txid: "f0".repeat(32), vout: 0 }], outputs: [{ value: 250000, script: addressScript(L1_RECEIVE_0) }] });
const FUNDING = { hex: FUNDING_HEX, txid: parseTx(FUNDING_HEX).txid, confirmed: true, blockHeight: 970800 };

/** What eCash's stub holds (read on every request); each browser starts from `l1Config()`. */
const L1 = {};
const l1Config = () => ({
  identityBlock: L1_FORK_BLOCK,
  blocks: { [ACTIVATION.height]: ACTIVATION.hash },
  tipHeight: 971000,
  feeEstimates: { 1: 0.97, 6: 2, 1008: 0.1 },
  txs: [FUNDING],
  utxos: { [L1_RECEIVE_0]: [{ txid: FUNDING.txid, vout: 0, value: 250000, confirmed: true }] },
  addressTxCounts: {},
  refuseBroadcast: undefined,
});
const ESPLORA = { identityBlock: { height: 0, hash: GENESIS }, utxos: {} };

/** The Send screen's ECX option, once its spendable coins are read. */
async function openSend(session) {
  const page = await openWalletPage(session, "#/send/l1");
  await page.waitForSelector('[data-send-asset] option[value=""]', { timeout: 20_000 });
  return page;
}

/** Fills the Send screen's one recipient and asks to review it. */
async function fill(page, amount, address) {
  await page.type('[data-send-row="0"] [data-send-amount]', amount);
  await page.type('[data-send-row="0"] [data-send-destination]', address);
  await page.click("[data-send-submit]");
}

const spendableText = (page) => page.$eval('[data-send-row="0"] [data-send-asset] option[value=""]', (e) => e.textContent.trim());

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let stub;
  let l1Stub;
  /** The Send that went out, and its change output. */
  let sent;
  before(async () => {
    Object.assign(L1, l1Config());
    [session, stub, l1Stub] = await Promise.all([launchWallet(browserName), serveEsplora(ESPLORA), serveL1Esplora(L1)]);
    await setUpWallet(session); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
    await stub?.close();
    await l1Stub?.close();
  });

  test("home's Send sheet offers the main chain", async () => {
    const home = await session.openPage("index.html#/");
    await home.waitForSelector("[data-send-action]", { timeout: 20_000 });
    await home.click("[data-send-action]");
    await home.waitForSelector('[data-send-link="l1"]:not([data-disabled])', { timeout: 20_000 });
    assert.equal(await home.$eval('[data-send-link="l1"]', (e) => e.getAttribute("href")), "#/send/l1");
    await homeSettled(home);
    await home.close();
  });

  test("Send on the main chain: built from the wallet's coins, reviewed in place, replay-marked and broadcast", async () => {
    const page = await openSend(session);
    assert.equal(await spendableText(page), "ECX (0.0025 ECX spendable)");
    assert.match(await page.$eval("[data-send-ecash-note]", (e) => e.textContent.replace(/\s+/g, " ").trim()), /This sends ECX on eCash; nothing arrives on Bitcoin\.$/);
    await fill(page, "0.0004", PAY_TO);

    const approval = await approvalIn(page, { timeout: 20_000 });
    await approval.waitForSelector("[data-output]");
    const review = await approval.evaluate(() => ({
      clearView: document.querySelector("[data-clear-view]") !== null,
      origin: document.querySelector("[data-origin]").textContent.trim(),
      chain: document.querySelector("[data-chain]").textContent.trim(),
      destinations: [...document.querySelectorAll("[data-output] [data-destination]")].map((e) => e.textContent.trim()),
      yours: [...document.querySelectorAll("[data-output]")].map((e) => e.querySelector("[data-yours]") !== null),
    }));
    assert.deepEqual(review, {
      clearView: true,
      origin: "This wallet (Send on Main chain)",
      chain: "ecash:betanet",
      destinations: [PAY_TO, L1_CHANGE_0],
      yours: [false, true],
    });
    await answerIn(approval, "[data-approve]");

    await page.waitForSelector("[data-send-done], [data-error]", { timeout: 20_000 });
    assert.equal(await page.$eval("[data-error]", (e) => e.textContent).catch(() => null), null);
    const [hex] = l1Stub.broadcasts();
    const tx = parseTx(hex);
    assert.equal(await page.$eval("[data-send-txid]", (e) => e.getAttribute("data-send-txid")), tx.txid);
    assert.equal(tx.locktime, 499999999, "betanet's replay nLockTime");
    assert.ok(tx.inputs.every((i) => i.sequence === 0xfffffffd), "non-final, replaceable nSequence on every input");
    assert.deepEqual(tx.inputs.map((i) => [i.txid, i.witness.length]), [[FUNDING.txid, 2]], "the coin, signed");
    assert.deepEqual(tx.outputs[0], { value: 40000, script: addressScript(PAY_TO) });
    assert.equal(tx.outputs[1].script, addressScript(L1_CHANGE_0), "change to the first unused change address");
    const fee = 250000 - tx.outputs.reduce((sum, o) => sum + o.value, 0);
    assert.ok(fee >= 2 * 141, `${fee} sats: at least the 6-block estimate of 2 sat/vB`);
    sent = { txid: tx.txid, change: tx.outputs[1].value };
    assert.equal(await page.$eval("[data-send-activity]", (e) => e.getAttribute("href")), "#/chain/l1/activity");
    await page.close();
  });

  test("its change is spendable at once, and the coin it spent is held while the server still lists it", async () => {
    // The server lists the change, unconfirmed, and hasn't caught up with the spent coin.
    L1.utxos = {
      [L1_RECEIVE_0]: [{ txid: FUNDING.txid, vout: 0, value: 250000, confirmed: true }],
      [L1_CHANGE_0]: [{ txid: sent.txid, vout: 1, value: sent.change, confirmed: false }],
    };
    L1.addressTxCounts = { [L1_CHANGE_0]: 1 };
    const page = await openSend(session);
    const ecx = (sats) => `${(sats / 1e8).toFixed(8).replace(/\.?0+$/, "")} ECX`;
    assert.equal(await spendableText(page), `ECX (${ecx(sent.change)} spendable)`);
    await page.close();
  });

  test("a Deposit right after doesn't pick the coin the Send spent", async () => {
    const page = await openWalletPage(session, "#/deposit/24");
    await page.waitForSelector("[data-deposit-amount]", { timeout: 20_000 });
    await page.type("[data-deposit-amount]", "0.0005");
    await page.click("[data-deposit-submit]");
    await page.waitForSelector("[data-deposit-done], [data-error]", { timeout: 20_000 });
    assert.match(await page.$eval("[data-error]", (e) => e.textContent.trim()), /^Not enough confirmed eCash: .* the wallet has 0\.$/);
    assert.equal(l1Stub.broadcasts().length, 1);
    await page.close();
  });

  test("a payment below what eCash relays is refused, and nothing is sent", async () => {
    const page = await openSend(session);
    await fill(page, "0.00000293", PAY_TO);
    await page.waitForSelector("[data-error]", { timeout: 20_000 });
    assert.match(await page.$eval("[data-error]", (e) => e.textContent.trim()), /below the smallest amount eCash relays to .* \(0\.00000294 ECX\)\.$/);
    assert.equal(l1Stub.broadcasts().length, 1);
    await page.close();
  });

  test("an address that isn't eCash's is refused", async () => {
    const page = await openSend(session);
    await fill(page, "0.0001", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
    await page.waitForSelector("[data-error]", { timeout: 20_000 });
    assert.match(await page.$eval("[data-error]", (e) => e.textContent.trim()), /isn't an eCash address this wallet pays\.$/);
    await page.close();
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });

  // After the runtime-errors check: closing the page while its `send.start` is pending makes Firefox
  // log "Promise rejected after context unloaded", as a real popup closing does.
  test("a Send refused after approval, with its page already closed, shows why in Activity until closed", async () => {
    L1.refuseBroadcast = 'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}';
    try {
      const page = await openSend(session);
      await fill(page, "0.0001", PAY_TO);
      await answerIn(await approvalIn(page, { timeout: 20_000 }), "[data-approve]");
      await page.close();

      const home = await session.openPage("index.html#/");
      await home.waitForSelector("[data-send-refused]", { timeout: 20_000 });
      await home.click('[data-tab="activity"]');
      await home.waitForSelector("[data-send-refused-close]", { visible: true });
      const refused = await home.$eval("[data-send-refused]", (e) => e.textContent.replace(/\s+/g, " ").trim());
      assert.match(refused, /^Your Send of 0.0001 ECX failed: .*min relay fee not met.* Nothing was sent\./);
      assert.equal(await home.$eval("[data-send-retry]", (e) => e.getAttribute("href")), "#/send/l1");
      await home.click("[data-send-refused-close]");
      await waitForFunction(home, () => document.querySelector("[data-send-refused]") === null, { timeout: 5_000 });
      await home.close();
    } finally {
      L1.refuseBroadcast = undefined;
    }
  });
});
