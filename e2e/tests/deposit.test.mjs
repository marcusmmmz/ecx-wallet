// Seam 1, Deposit (#31): from the Slot 24 card, the wallet deposits eCash with an M5 it builds from
// its own confirmed coins, after the user reviews the L1 Decoder's Clear View in the approval
// window; then it follows the Deposit on the home page.
//
// eCash's server is the stub Esplora server where the e2e build's Chain Entry names it. Its
// transactions are real raw transactions (made-up inputs), so the L1 module can check every
// value and script against its txid; the stub indexes them as Esplora would.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { addressScript, encodeTx, parseTx, scripthash } from "@ecx/stub-server/bitcoin-tx";
import { activitySettled, answerIn, approvalIn, BROWSERS, homeSettled, importWallet, launchWallet, openWalletPage, serveEsplora, serveL1Esplora, setUpWallet, waitForFunction } from "../harness.mjs";

const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
/** Slot 24's first receive address for "abandon … about": where its Deposits are credited. */
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const L1_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const L1_RECEIVE_0_SCRIPT = "0014c0cebcd6c3d3ca8c75dc5ec62ebe55330ef910e2";
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
/** Slot 24's activation, as its Chain Entry pins it. */
const ACTIVATION = { height: 970715, hash: "000000000000000094c4b58e192ea0105c5e82c3eaf168ab53090254bc9a3c3c" };
/** betanet's Slot 24 Treasury script, `OP_NOP8 <24> OP_TRUE`. */
const TREASURY = "b7011851";
const hexOf = (text) => Buffer.from(text, "utf8").toString("hex");
/** An M5's address output: `OP_RETURN <48 bytes>`. */
const ADDRESS_OUTPUT = `6a30${hexOf(RECEIVE_0)}`;

/** A confirmed transaction from a made-up input (`seed` keeps txids apart). */
const tx = (seed, outputs, { confirmed = true, inputs } = {}) => {
  const hex = encodeTx({ inputs: inputs ?? [{ txid: seed.repeat(32), vout: 0 }], outputs });
  return { hex, txid: parseTx(hex).txid, confirmed, blockHeight: 970800 };
};
const FUNDING = tx("f0", [{ value: 250000, script: L1_RECEIVE_0_SCRIPT }]);
/** Slot 24's Treasury, created by an M5. */
const TREASURY_TX = tx("f1", [{ value: 100000, script: TREASURY }, { value: 0, script: ADDRESS_OUTPUT }]);
const OTHER_TREASURY_TX = tx("f2", [{ value: 7000, script: TREASURY }, { value: 0, script: ADDRESS_OUTPUT }]);
/**
 * Paid to the Treasury script, but not by an M5 (no address after it) or an M6 (not output 0): never
 * a Treasury. (A payment with one input to output 0 would look like an M6: the rule can't tell.)
 */
const STRAY = tx("f3", [{ value: 1000, script: L1_RECEIVE_0_SCRIPT }, { value: 5000, script: TREASURY }]);

/** What eCash's stub holds (read on every request); each test starts from `l1Config()`. */
const L1 = {};
const l1Config = (txs) => ({
  identityBlock: L1_FORK_BLOCK,
  blocks: { [ACTIVATION.height]: ACTIVATION.hash },
  tipHeight: 971000,
  feeEstimates: { 1: 0.97, 6: 2, 1008: 0.1 },
  txs,
  utxos: { [L1_RECEIVE_0]: [{ txid: FUNDING.txid, vout: 0, value: 250000, confirmed: true }] },
  addressTxCounts: {},
  refuseBroadcast: undefined,
  delayMs: 0,
  txHexOverrides: {},
});
const ESPLORA = { identityBlock: { height: 0, hash: GENESIS }, utxos: {} };

/** Sats as the Deposit screen takes them by default: in ECX ("50000" is "0.0005"). */
const inEcx = (sats) => (Number(sats) / 1e8).toFixed(8).replace(/\.?0+$/, "");

/** Starts a Deposit of `amount` sats from the Deposit screen; returns the page (the deposit is pending). */
async function startDeposit(session, amount) {
  const page = await openWalletPage(session, "#/deposit/24");
  await page.waitForSelector("[data-deposit-available]", { timeout: 20_000 });
  await page.type("[data-deposit-amount]", inEcx(amount));
  await page.click("[data-deposit-submit]");
  return page;
}

/** What the Deposit screen ended with: its result or its error. */
async function outcome(page) {
  await page.waitForSelector("[data-deposit-done], [data-error]", { timeout: 20_000 });
  return page.evaluate(() => ({
    txid: document.querySelector("[data-deposit-txid]")?.textContent.trim(),
    error: document.querySelector("[data-error]")?.textContent.trim(),
  }));
}

/** The approval window's Clear View, as a user reads it. */
async function readDepositView(approval) {
  return approval.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return {
      clearView: document.querySelector("[data-clear-view]") !== null,
      origin: text(document.querySelector("[data-origin]")),
      chain: text(document.querySelector("[data-chain]")),
      dangerous: [...document.querySelectorAll("[data-dangerous-mode]")].map(text),
      deposit: text(document.querySelector("[data-deposit]")),
      depositAmount: text(document.querySelector("[data-deposit-amount]")),
      treasury: text(document.querySelector("[data-treasury]")),
      creditedToYou: document.querySelector("[data-deposit] ~ [data-yours]") !== null,
      inputs: [...document.querySelectorAll("[data-input]")].map(text),
      fee: text(document.querySelector("[data-fee]")),
      outputs: [...document.querySelectorAll("[data-output]")].map(text),
    };
  });
}

/**
 * The pending Deposits on home's Activity tab, once Slot 24's are loaded. The page closes only once
 * home has settled: closing it with a request pending is a Firefox runtime error (#43).
 */
async function readDeposits(session) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector('[data-account="24"][data-deposits-ready]', { timeout: 20_000 });
  const shown = await page.evaluate(() =>
    [...document.querySelectorAll("[data-deposit]")].map((e) => ({
      txid: e.getAttribute("data-deposit"),
      shownTxid: e.querySelector("[data-deposit-txid]")?.textContent.trim(),
      stopTracking: e.querySelector("[data-deposit-stop-tracking]") !== null,
      state: e.getAttribute("data-deposit-state"),
      status: e.querySelector("[data-deposit-status]").textContent.trim(),
      note: e.closest("section").querySelector("[data-deposits-note]").textContent.trim(),
      claim: e.querySelector("[data-claim]")
        ? Object.fromEntries(["txid", "vout", "block", "address", "value"].map((k) => [k, e.querySelector(`[data-claim-${k}]`).textContent.trim()]))
        : undefined,
    })),
  );
  await homeSettled(page);
  await page.close();
  return shown;
}

describe("the fee rate", async () => {
  const { feeRate } = await importWallet();
  test("is the 6-block estimate, never below the 1008-block one or 0.1 sat/vB, and 1 sat/vB without one", () => {
    assert.equal(feeRate({ 1: 0.97, 6: 0.5, 1008: 0.1 }), 500);
    assert.equal(feeRate({ 6: 0.05, 1008: 0.08 }), 100);
    assert.equal(feeRate({ 6: 0.2, 1008: 0.3 }), 300);
    assert.equal(feeRate({ 1: 3 }), 1000);
    assert.equal(feeRate(undefined), 1000);
  });
});

describe("finding a Deposit's credit", async () => {
  const { isCredited } = await importWallet();
  /** Made when the Slot's tip was 5000. */
  const deposit = { txid: "d0".repeat(32), address: "elements1q…", slotHeight: 5000 };
  const credit = (status) => ({ txid: "c0".repeat(32), vin: [{ txid: deposit.txid, vout: 0, prevout: null, claimsDeposit: true }], vout: [], status });
  const other = (n, status) => ({ txid: n.toString(16).padStart(64, "0"), vin: [{ txid: "d1".repeat(32), vout: 0, prevout: null, claimsDeposit: true }], vout: [], status });
  const at = (blockHeight) => ({ confirmed: true, blockHeight, blockHash: "00".repeat(32) });
  /** An Esplora server whose address lists `txs` (newest first), 25 confirmed at a time; `pages` counts the reads. */
  const server = (txs) => {
    const listed = txs.filter((tx) => tx.status.confirmed);
    const reads = { pages: 0 };
    return {
      reads,
      addressTxs: async () => (reads.pages++, [...txs.filter((tx) => !tx.status.confirmed), ...listed.slice(0, 25)]),
      addressTxsBefore: async (_, txid) => {
        reads.pages++;
        const after = listed.findIndex((tx) => tx.txid === txid);
        return listed.slice(after + 1, after + 26);
      },
    };
  };
  const newer = (count) => Array.from({ length: count }, (_, i) => other(i, at(5100 - i)));
  const older = (count) => Array.from({ length: count }, (_, i) => other(1000 + i, at(4900 - i)));

  test("is found unconfirmed, on the first page", async () => {
    const s = server([credit({ confirmed: false }), ...newer(30)]);
    assert.equal(await isCredited(s, deposit), true);
    assert.equal(s.reads.pages, 1);
  });

  test("is found confirmed under more than a page of newer transactions", async () => {
    const s = server([...newer(30), credit(at(5001)), ...older(30)]);
    assert.equal(await isCredited(s, deposit), true);
    assert.equal(s.reads.pages, 2);
  });

  test("is found just below the Slot's tip when the Deposit was made, after a reorg there", async () => {
    const s = server([...newer(24), credit(at(4995)), ...older(30)]);
    assert.equal(await isCredited(s, deposit), true);
  });

  test("isn't looked for below the Slot's tip when the Deposit was made, nor past the last page", async () => {
    const s = server([...newer(30), ...older(100)]);
    assert.equal(await isCredited(s, deposit), false);
    assert.equal(s.reads.pages, 2, "page 2 reaches older blocks: no page 3");
    const short = server(newer(9));
    assert.equal(await isCredited(short, deposit), false);
    assert.equal(short.reads.pages, 1, "a page under 10 is the last, whatever the server's page size");
    const ten = server(newer(10));
    assert.equal(await isCredited(ten, deposit), false);
    assert.equal(ten.reads.pages, 2, "a page of 10 may be full (explorer.blockfab.org lists 10): the next is read, and is empty");
  });

  test("without the Slot's height, every page is read", async () => {
    const s = server([...newer(30), ...older(100), credit(at(4000))]);
    assert.equal(await isCredited(s, { ...deposit, slotHeight: undefined }), true);
    assert.equal(s.reads.pages, 6);
  });

  test("an input with the Deposit's txid that doesn't claim it isn't its credit", async () => {
    const spend = { ...credit({ confirmed: false }), vin: [{ txid: deposit.txid, vout: 0, prevout: { scriptpubkey: "" } }] };
    assert.equal(await isCredited(server([spend]), deposit), false);
  });
});

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let stub;
  let l1Stub;
  before(async () => {
    Object.assign(L1, l1Config([FUNDING, TREASURY_TX, STRAY]));
    [session, stub, l1Stub] = await Promise.all([launchWallet(browserName), serveEsplora(ESPLORA), serveL1Esplora(L1)]);
    await setUpWallet(session); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
    await stub?.close();
    await l1Stub?.close();
  });

  test("the Deposit screen takes an amount at once, shows the last balance, and says it's still scanning", async () => {
    L1.delayMs = 1500;
    try {
      const page = await openWalletPage(session, "#/deposit/24");
      assert.ok(await page.$("[data-deposit-amount]"), "the form doesn't wait for the scan");
      await page.waitForSelector("[data-deposit-scanning]", { timeout: 5_000 });
      await page.waitForSelector("[data-deposit-available]", { timeout: 5_000 }); // this session's last, from the home page
      assert.match(await page.$eval("[data-deposit-scanning]", (e) => e.textContent.trim()), /^Last read at .+; scanning your main-chain addresses again…$/);
      await waitForFunction(page, () => document.querySelector("[data-deposit-scanning]") === null, { timeout: 20_000 });
      assert.match(await page.$eval("[data-deposit-available]", (e) => e.textContent), /^0\.0025 ECX$/);
      assert.equal(await page.$("[data-deposit-unconfirmed]"), null, "nothing unconfirmed, no line for it");
      await page.close();
    } finally {
      L1.delayMs = 0;
    }
  });

  describe("with a Treasury", () => {
    let depositTxid;

    test("the Clear View shows the Deposit, credited to the wallet's own Slot 24 address, and the Treasury it grows", async () => {
      const page = await startDeposit(session, "50000");
      const approval = await approvalIn(page, { timeout: 20_000 });
      assert.equal((await session.approvalWindows()).length, 0, "the Deposit screen shows its approval itself: a window would close the popup");
      const shown = await readDepositView(approval);

      assert.equal(shown.clearView, true);
      assert.equal(shown.origin, "This wallet (Deposit from the main chain)");
      assert.equal(shown.chain, "ecash:betanet");
      assert.equal(shown.dangerous.length, 1, "a Deposit, but not a first one");
      assert.match(shown.dangerous[0], /only come back through a Withdrawal/);
      assert.match(shown.dangerous[0], /isn't automatic/);
      assert.equal(shown.depositAmount, "0.0005 ECX");
      assert.equal(shown.deposit, `Deposit 0.0005 ECX to Slot 24 (Elements+). 0.0005 ECX credited to ${RECEIVE_0} after 6 blocks, once the operator imports it.`);
      assert.equal(shown.creditedToYou, true);
      assert.match(shown.treasury, /Treasury: 0\.001 ECX → 0\.0015 ECX/);
      assert.deepEqual(shown.inputs, ["Input 0: 0.001 ECX (Slot 24's Treasury: spent and recreated)", "Input 1: 0.0025 ECX (yours: you sign it)"]);
      assert.match(shown.fee, /^0\.0000\d+ ECX$/);
      assert.equal(shown.outputs.length, 2, "the Deposit and the change");
      assert.match(shown.outputs[1], /Yours/);

      // Slot 24's server takes 10 s for its tip height, read after the broadcast: the Deposit doesn't wait for it.
      ESPLORA.pathDelayMs = { "/blocks/tip/height": 10_000 };
      try {
        const approvedAt = Date.now();
        await approval.click("[data-approve]");
        const { txid, error } = await outcome(page);
        assert.equal(error, undefined);
        assert.ok(Date.now() - approvedAt < 8_000, "done without the Slot's tip height");
        assert.ok(stub.requests().includes("/blocks/tip/height"));
        depositTxid = txid;
      } finally {
        delete ESPLORA.pathDelayMs;
      }
      await page.close();
    });

    test("what was broadcast is the signed, replay-marked M5: Treasury, address, change", async () => {
      const [hex] = l1Stub.broadcasts();
      const m5 = parseTx(hex);
      assert.equal(m5.txid, depositTxid);
      assert.equal(m5.locktime, 499999999, "betanet's replay nLockTime");
      assert.ok(m5.inputs.every((i) => i.sequence === 0xfffffffd), "non-final nSequence on every input");
      assert.deepEqual([m5.inputs[0].txid, m5.inputs[0].vout, m5.inputs[0].script, m5.inputs[0].witness], [TREASURY_TX.txid, 0, "", []]);
      assert.deepEqual([m5.inputs[1].txid, m5.inputs[1].witness.length], [FUNDING.txid, 2], "the coin, signed");
      assert.deepEqual(m5.outputs[0], { value: 150000, script: TREASURY });
      assert.deepEqual(m5.outputs[1], { value: 0, script: ADDRESS_OUTPUT });
      const fee = 350000 - m5.outputs.reduce((sum, o) => sum + o.value, 0);
      assert.ok(fee >= 2 * 150, `${fee} sats: at least the 6-block estimate of 2 sat/vB`);

      const requests = l1Stub.requests();
      assert.ok(requests.includes(`/scripthash/${scripthash(TREASURY)}/utxo`), "the Treasury is looked up by its script");
      assert.ok(requests.includes("/fee-estimates"));
    });

    test("home's Activity tab follows it, showing its txid: confirmations, then the operator's import with the claim, then credited", async () => {
      assert.deepEqual(
        (await readDeposits(session)).map(({ txid, shownTxid, stopTracking, state, status }) => ({ txid, shownTxid, stopTracking, state, status })),
        [{ txid: depositTxid, shownTxid: depositTxid, stopTracking: false, state: "confirming", status: "0 / 6 confirmations on the main chain" }],
      );

      const broadcast = L1.txs.find((t) => parseTx(t.hex).txid === depositTxid);
      Object.assign(broadcast, { confirmed: true, blockHeight: 970950, blockHash: "ab".repeat(32) });
      L1.tipHeight = 970952;
      assert.equal((await readDeposits(session))[0].status, "3 / 6 confirmations on the main chain");

      L1.tipHeight = 970955;
      const [waiting] = await readDeposits(session);
      assert.equal(waiting.state, "awaitingCredit");
      assert.match(waiting.note, /^Deposits wait 6 main-chain blocks, then/);
      assert.equal(waiting.status, "Waiting for the Elements+ operator to credit it (not automatic)");
      assert.deepEqual(waiting.claim, { txid: depositTxid, vout: "0", block: "ab".repeat(32), address: RECEIVE_0, value: "50000" });

      // Elements transactions, as the Slot's Esplora lists them: one paying the address, then Deposits' credits.
      const toReceive0 = (txid, vin) => ({
        txid,
        vin,
        vout: [{ scriptpubkey: addressScript(RECEIVE_0), value: 50000, asset: POLICY_ASSET }],
        status: { confirmed: false },
      });
      const claiming = (txid) => ({ txid, vout: 0, prevout: null, is_coinbase: false, is_pegin: true });
      // The same amount to the address isn't the credit, nor another Deposit's credit.
      ESPLORA.addressTxs = {
        [RECEIVE_0]: [
          toReceive0("c0".repeat(32), [{ txid: "d0".repeat(32), vout: 0, prevout: { scriptpubkey: "0014" + "ab".repeat(20), value: 60000, asset: POLICY_ASSET }, is_coinbase: false }]),
          toReceive0("c1".repeat(32), [claiming("d1".repeat(32))]),
        ],
      };
      assert.equal((await readDeposits(session))[0].state, "awaitingCredit");
      // The credit counts as soon as the server lists it, before it confirms on the Slot.
      ESPLORA.addressTxs[RECEIVE_0].push(toReceive0("c2".repeat(32), [claiming(depositTxid)]));
      const [credited] = await readDeposits(session);
      assert.equal(credited.state, "credited");
      assert.match(credited.status, new RegExp(`^Credited, as reported by ${stub.url.replace(/[.]/g, "\\.")}$`));
      assert.deepEqual(await readDeposits(session), [], "reported once, then forgotten");
      delete ESPLORA.addressTxs;
    });

    test("a pending Deposit to the Slot is followed: the next one spends the Treasury it creates", async () => {
      const pending = tx("f4", [{ value: 120000, script: TREASURY }, { value: 0, script: ADDRESS_OUTPUT }], {
        confirmed: false,
        inputs: [{ txid: TREASURY_TX.txid, vout: 0 }, { txid: "f5".repeat(32), vout: 0 }],
      });
      Object.assign(L1, l1Config([FUNDING, TREASURY_TX, pending]));
      const page = await startDeposit(session, "5000");
      const approval = await approvalIn(page, { timeout: 20_000 });
      assert.match((await readDepositView(approval)).treasury, /Treasury: 0\.0012 ECX → 0\.00125 ECX/);
      await answerIn(approval, "[data-reject]");
      assert.equal((await outcome(page)).error, "The user rejected the request.");
      await page.close();
      const fetched = l1Stub.requests().filter((r) => r === `/tx/${FUNDING.txid}/hex`).length;
      assert.equal(fetched, 1, "the coin's transaction was fetched for the first Deposit only, then kept");
    });
  });

  describe("refusals", () => {
    beforeEach(() => Object.assign(L1, l1Config([FUNDING, TREASURY_TX])));

    for (const [name, setUp, amount, expected] of [
      ["two Treasuries: the Slot's can't be determined", () => L1.txs.push(OTHER_TREASURY_TX), "5000", /^Can't determine Slot 24's Treasury: http:\/\/127\.0\.0\.1:24000 shows 2 Treasuries/],
      ["below the Slot's minimum", () => {}, "2999", /^The smallest Deposit to Slot 24 is 3000 sats\.$/],
      ["more than the confirmed coins", () => {}, "300000", /^Not enough confirmed eCash: the deposit needs [0-9]+ sats with its fee, and the wallet has 250000\.$/],
      ["no Treasury and a server without the pinned activation block", () => ((L1.txs = [FUNDING]), (L1.blocks = {})), "5000", /doesn't have Slot 24's activation block 970715/],
    ]) {
      test(`${name}: refused before any approval window`, async () => {
        setUp();
        const page = await startDeposit(session, amount);
        assert.match((await outcome(page)).error, expected);
        assert.equal((await session.approvalWindows()).length, 0);
        await page.close();
      });
    }

    test("unconfirmed coins show apart on the Deposit screen, and a Deposit doesn't spend them", async () => {
      L1.utxos[L1_RECEIVE_0].push({ txid: "c9".repeat(32), vout: 0, value: 80000, confirmed: false });
      const page = await openWalletPage(session, "#/deposit/24");
      await page.waitForSelector("[data-deposit-unconfirmed]", { timeout: 20_000 });
      await waitForFunction(page, () => document.querySelector("[data-deposit-scanning]") === null, { timeout: 20_000 });
      const text = (selector) => page.$eval(selector, (e) => e.textContent.replace(/\s+/g, " ").trim());
      assert.equal(await text("[data-deposit-available]"), "0.0025 ECX");
      assert.equal(await text("[data-deposit-unconfirmed]"), "+0.0008 ECX unconfirmed, usable once confirmed");
      await page.type("[data-deposit-amount]", "0.003"); // enough with the unconfirmed coin
      await page.click("[data-deposit-submit]");
      assert.match((await outcome(page)).error, /^Not enough confirmed eCash: .* the wallet has 250000\.$/);
      assert.equal((await session.approvalWindows()).length, 0);
      await page.close();
    });

    test("a Deposit the server no longer knows can be stopped tracking", async () => {
      const page = await startDeposit(session, "5000");
      await answerIn(await approvalIn(page, { timeout: 20_000 }), "[data-approve]");
      const { txid } = await outcome(page);
      await page.close();
      L1.txs = L1.txs.filter((t) => parseTx(t.hex).txid !== txid); // dropped from the server's mempool

      const [dropped] = await readDeposits(session);
      assert.deepEqual({ txid: dropped.txid, state: dropped.state, stopTracking: dropped.stopTracking }, { txid, state: "notFound", stopTracking: true });
      const home = await session.openPage("index.html#/");
      await home.waitForSelector(`[data-deposit="${txid}"] [data-deposit-stop-tracking]`, { timeout: 20_000 });
      await home.click('[data-tab="activity"]');
      await home.waitForSelector("[data-deposit-stop-tracking]", { visible: true });
      assert.equal(await home.$eval("[data-deposit-stop-tracking]", (e) => e.textContent.trim()), "Stop tracking");
      await home.click("[data-deposit-stop-tracking]");
      await waitForFunction(home, (t) => document.querySelector(`[data-deposit="${t}"]`) === null, { timeout: 10_000 }, txid);
      await activitySettled(home);
      await home.close();
      assert.deepEqual(await readDeposits(session), []);
    });

    test("a server that sends another transaction than the one asked for is refused, and nothing is kept", async () => {
      // A Treasury this session hasn't fetched yet (the earlier ones' transactions are kept).
      const unseen = tx("f6", [{ value: 100000, script: TREASURY }, { value: 0, script: ADDRESS_OUTPUT }]);
      L1.txs = [FUNDING, unseen];
      L1.txHexOverrides = { [unseen.txid]: OTHER_TREASURY_TX.hex };
      const page = await startDeposit(session, "5000");
      assert.equal((await outcome(page)).error, `The Sidechain Server at http://127.0.0.1:24000 sent another transaction than ${unseen.txid}.`);
      // Answering truthfully now, it gets the real one: the lie wasn't kept.
      L1.txHexOverrides = {};
      const retry = await startDeposit(session, "5000");
      await answerIn(await approvalIn(retry, { timeout: 20_000 }), "[data-reject]");
      assert.equal((await outcome(retry)).error, "The user rejected the request.");
      await retry.close();
      assert.equal((await session.approvalWindows()).length, 0);
      await page.close();
    });

    test("a first Deposit (no Treasury, the activation pinned) warns that the funds can be lost; rejecting sends nothing", async () => {
      L1.txs = [FUNDING];
      const broadcasts = l1Stub.broadcasts().length;
      const page = await startDeposit(session, "5000");
      const approval = await approvalIn(page, { timeout: 20_000 });
      const shown = await readDepositView(approval);
      assert.equal(shown.dangerous.length, 2);
      assert.match(shown.dangerous.join("\n"), /no Treasury on the main chain's server, so this is its first Deposit.*funds can be lost/);
      assert.match(shown.treasury, /Treasury: 0 ECX → 0\.00005 ECX/);
      assert.ok(shown.inputs.every((i) => !/Treasury/.test(i)), "no Treasury is spent");

      await answerIn(approval, "[data-reject]");
      assert.equal((await outcome(page)).error, "The user rejected the request.");
      assert.equal(l1Stub.broadcasts().length, broadcasts);
      await page.close();
    });

    test("a refused broadcast says nothing was sent, and how to try again", async () => {
      L1.refuseBroadcast = 'sendrawtransaction RPC error: {"code":-26,"message":"bad-txns-inputs-missingorspent"}';
      const page = await startDeposit(session, "5000");
      await answerIn(await approvalIn(page, { timeout: 20_000 }), "[data-approve]");
      const { error } = await outcome(page);
      assert.match(error, /missingorspent.*Nothing was sent\. If another Deposit to Slot 24 took its Treasury first, start again/);
      assert.deepEqual(await readDeposits(session), []);
      await page.close();
    });
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });

  // After the runtime-errors check: closing the page while its `deposit.start` is pending makes
  // Firefox log "Promise rejected after context unloaded", as a real popup closing does.
  test("a Deposit refused after approval, with its page already closed (as the popup closes), shows why on the home page until closed", async () => {
    Object.assign(L1, l1Config([FUNDING, TREASURY_TX]));
    L1.refuseBroadcast = 'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}';
    const page = await startDeposit(session, "5000");
    await answerIn(await approvalIn(page, { timeout: 20_000 }), "[data-approve]");
    await page.close();

    const home = await session.openPage("index.html#/");
    await home.waitForSelector("[data-deposit-refused]", { timeout: 20_000 });
    await home.click('[data-tab="activity"]');
    await home.waitForSelector("[data-deposit-refused-close]", { visible: true });
    const refused = await home.$eval("[data-deposit-refused]", (e) => e.textContent.replace(/\s+/g, " ").trim());
    assert.match(refused, /^Your Deposit of 0.00005 ECX failed: .*min relay fee not met.* Nothing was sent\./);
    assert.equal(await home.$eval("[data-deposit-retry]", (e) => [e.textContent.trim(), e.getAttribute("href")].join(" → ")), "Try again → #/deposit/24");
    await home.click("[data-deposit-refused-close]");
    await waitForFunction(home, () => document.querySelector("[data-deposit-refused]") === null, { timeout: 5_000 });
    await home.close();
    const again = await session.openPage("index.html#/");
    await again.waitForSelector('[data-account="24"][data-deposits-ready]', { timeout: 20_000 });
    assert.equal(await again.$("[data-deposit-refused]"), null, "closed for good");
    await again.close();
  });
});
