// Seam 1, transaction history (#33): the Activity tabs (home's, every chain's merged; a chain
// screen's, its own) list the transactions touching the addresses the wallet watches, as each
// chain's Sidechain Server reports them: the wallet's net change per asset, pending or confirmed,
// by day; tapping one shows its details, the txid among them.
//
// eCash's server is the stub Esplora server, which lists an address's transactions from the raw
// transactions in its `txs` (made-up inputs), as an indexer would.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { addressScript, encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import { BROWSERS, homeSettled, importWallet, launchWallet, openWalletPage, serveEsplora, serveL1Esplora, setUpWallet, waitForFunction } from "../harness.mjs";

const { HISTORY_PAGES } = await importWallet();

const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
const L1_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const L1_CHANGE_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";
/** Slot 24's first receive address: where its Deposits are credited. */
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const RECEIVE_1 = "elements1qnx6kczxpu35ypahwhqddx2pn6q0nuyaap97ygn";
const CHANGE_0 = "elements1q2n6usykz5ycrnfpup3hx0qa0manae07jgvvmuc";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const OTHER_ASSET = "1111111111111111111111111111111111111111111111111111111111111111";
/** betanet's Slot 24 Treasury script, `OP_NOP8 <24> OP_TRUE`. */
const TREASURY = "b7011851";
/** An M5's address output: `OP_RETURN <48 bytes>`. */
const ADDRESS_OUTPUT = `6a30${Buffer.from(RECEIVE_0, "utf8").toString("hex")}`;
/** Someone else's script. */
const FOREIGN = "0014" + "ab".repeat(20);

/** A transaction from made-up inputs (`seed` keeps txids apart); confirmed at `blockHeight` unless `confirmed: false`. */
const tx = (seed, outputs, { inputs, confirmed = true, blockHeight = 970800, blockTime = 1792000000 } = {}) => {
  const hex = encodeTx({ inputs: inputs ?? [{ txid: seed.repeat(32), vout: 0 }], outputs });
  return { hex, txid: parseTx(hex).txid, confirmed, blockHeight, blockTime };
};

/** What eCash's stub holds (read on every request); each test sets `txs`. */
const L1 = { identityBlock: L1_FORK_BLOCK, txs: [] };
const ESPLORA = { identityBlock: { height: 0, hash: GENESIS } };

/** Opens `chain`'s screen on its Activity tab (or home's, for "home"), once its transactions are in. */
async function openActivity(session, chain) {
  const page = chain === "home" ? await session.openPage("index.html#/") : await openWalletPage(session, `#/chain/${chain}`);
  await page.waitForSelector('[data-tab="activity"]', { timeout: 20_000 });
  await page.click('[data-tab="activity"]');
  return page;
}

/** Closes an Activity page once every read it started has answered (Firefox logs replies to a closed page). */
async function closeSettled(page) {
  if (await page.$("[data-chain-screen]")) await page.waitForSelector("[data-chain-screen][data-settled]", { timeout: 20_000 });
  else await homeSettled(page);
  await page.close();
}

/** An Activity tab's entries once refreshed, as a user reads them. */
async function readHistory(session, chain) {
  const page = await openActivity(session, chain);
  await page.waitForSelector("[data-activity]:not([data-refreshing])", { timeout: 20_000 });
  const shown = await page.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return {
      error: text(document.querySelector("[data-history-error]")),
      empty: text(document.querySelector("[data-history-empty]")),
      more: text(document.querySelector("[data-history-more]")),
      days: [...document.querySelectorAll("[data-activity] .day h2")].map(text),
      entries: [...document.querySelectorAll("[data-history-entry]")].map((e) => ({
        txid: e.getAttribute("data-history-entry"),
        chain: e.getAttribute("data-history-chain"),
        state: e.getAttribute("data-history-state"),
        amounts: [...e.querySelectorAll("[data-history-amount]")].map(text),
        status: text(e.querySelector("[data-history-status]")),
        time: e.querySelector("[data-history-status] time")?.getAttribute("datetime"),
        warning: e.querySelector("[data-history-status]")?.getAttribute("title") ?? undefined,
        label: text(e.querySelector("[data-history-label]")),
        hidden: text(e.querySelector("[data-history-hidden]")),
      })),
    };
  });
  await closeSettled(page);
  return shown;
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let l1Stub;
  let stub;
  before(async () => {
    [session, l1Stub, stub] = await Promise.all([launchWallet(browserName), serveL1Esplora(L1), serveEsplora(ESPLORA)]);
    await setUpWallet(session);
  });
  after(async () => {
    await session?.close();
    await l1Stub?.close();
    await stub?.close();
  });
  beforeEach(() => {
    L1.txs = [];
  });

  test("The main chain's History shows a received transaction: +N ECX, when it confirmed, and its txid, labelled as reported by the server", async () => {
    const received = tx("c0", [{ value: 40000, script: addressScript(L1_RECEIVE_0) }, { value: 9000, script: FOREIGN }]);
    L1.txs = [received];
    const shown = await readHistory(session, "l1");
    assert.equal(shown.error, undefined);
    assert.equal(shown.entries.length, 1);
    const [entry] = shown.entries;
    assert.equal(entry.txid, received.txid);
    assert.equal(entry.state, "confirmed");
    assert.deepEqual(entry.amounts, ["+0.0004 ECX"], "only what reached the wallet's address");
    assert.equal(entry.time, new Date(1792000000 * 1000).toISOString(), "the block's time");
    assert.equal(entry.label, "Received");
    assert.equal(shown.more, undefined, "nothing older left out");

    // Its details: the full txid and who reported it.
    const page = await openActivity(session, "l1");
    await page.waitForSelector(`[data-history-entry="${received.txid}"]`, { timeout: 20_000 });
    await page.click(`[data-history-entry="${received.txid}"]`);
    await page.waitForSelector("[data-activity-details]");
    const details = await page.evaluate(() => ({
      txid: document.querySelector("[data-details-txid]").textContent.trim(),
      reportedBy: document.querySelector("[data-details-reported-by]").textContent.trim(),
      mined: document.querySelector("[data-details-mined]")?.textContent.trim(),
    }));
    await closeSettled(page);
    assert.equal(details.txid, received.txid);
    assert.match(details.reportedBy, new RegExp(`^Reported by ${l1Stub.url.replace(/[.]/g, "\\.")}\\.`));
    assert.ok(details.mined, "when it was mined");
  });

  test("a spend shows what left the wallet, fee included, once, though it touches two of its addresses; newest first", async () => {
    const funding = tx("c1", [{ value: 50000, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970800 });
    const spend = tx("", [{ value: 30000, script: FOREIGN }, { value: 19000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: funding.txid, vout: 0 }],
      blockHeight: 970801,
    });
    L1.txs = [funding, spend];
    const shown = await readHistory(session, "l1");
    assert.deepEqual(shown.entries.map((e) => [e.txid, e.amounts]), [
      [spend.txid, ["−0.00031 ECX"]],
      [funding.txid, ["+0.0005 ECX"]],
    ]);
    assert.equal(shown.entries[0].label, "Sent");
  });

  test("a transaction to yourself shows the fee it cost, labelled as such", async () => {
    const funding = tx("c2", [{ value: 50000, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970800 });
    const consolidation = tx("", [{ value: 49000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: funding.txid, vout: 0 }],
      blockHeight: 970801,
    });
    L1.txs = [funding, consolidation];
    const [entry] = (await readHistory(session, "l1")).entries;
    assert.equal(entry.txid, consolidation.txid);
    assert.deepEqual(entry.amounts, ["−0.00001 ECX"]);
    assert.equal(entry.label, "Fee, to yourself");
  });

  test("a Deposit is labelled with its Slot; a Withdrawal paid out of the Treasury isn't", async () => {
    const funding = tx("c3", [{ value: 50000, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970800 });
    const oldTreasury = tx("c4", [{ value: 100000, script: TREASURY }, { value: 0, script: ADDRESS_OUTPUT }], { blockHeight: 970800 });
    const deposit = tx("", [{ value: 120000, script: TREASURY }, { value: 0, script: ADDRESS_OUTPUT }, { value: 9000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: oldTreasury.txid, vout: 0 }, { txid: funding.txid, vout: 0 }],
      blockHeight: 970801,
    });
    // An M6: the Treasury pays a Withdrawal to the wallet, and keeps the rest at output 0.
    const withdrawal = tx("", [{ value: 100000, script: TREASURY }, { value: 15000, script: addressScript(L1_RECEIVE_0) }], {
      inputs: [{ txid: deposit.txid, vout: 0 }],
      blockHeight: 970802,
    });
    L1.txs = [funding, oldTreasury, deposit, withdrawal];
    const shown = await readHistory(session, "l1");
    assert.deepEqual(shown.entries.map((e) => [e.txid, e.amounts, e.label]), [
      [withdrawal.txid, ["+0.00015 ECX"], "Received"],
      [deposit.txid, ["−0.00041 ECX"], "Deposit to Elements+"],
      [funding.txid, ["+0.0005 ECX"], "Received"],
    ]);
  });

  test("unconfirmed transactions come first: 'Pending' if they spend only the wallet's own coins, else 'Unconfirmed', with a warning", async () => {
    const funding = tx("c5", [{ value: 50000, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970800 });
    const ownSpend = tx("", [{ value: 30000, script: FOREIGN }, { value: 19000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: funding.txid, vout: 0 }],
      confirmed: false,
    });
    const incoming = tx("c6", [{ value: 8000, script: addressScript(L1_RECEIVE_0) }], { confirmed: false });
    // The wallet's own spend, but of a coin someone else's unconfirmed transaction paid it.
    const spendOfIncoming = tx("", [{ value: 7000, script: addressScript(L1_CHANGE_0) }], {
      inputs: [{ txid: incoming.txid, vout: 0 }],
      confirmed: false,
    });
    L1.txs = [funding, ownSpend, incoming, spendOfIncoming];
    const shown = await readHistory(session, "l1");
    const byTxid = Object.fromEntries(shown.entries.map((e) => [e.txid, e]));
    assert.deepEqual(shown.entries.map((e) => e.txid).slice(3), [funding.txid], "the confirmed one last");
    assert.equal(byTxid[ownSpend.txid].state, "pending");
    assert.equal(byTxid[ownSpend.txid].status, "Pending");
    assert.equal(byTxid[incoming.txid].state, "unconfirmed");
    assert.equal(byTxid[incoming.txid].status, "Unconfirmed");
    assert.equal(byTxid[incoming.txid].warning, "Sent by someone else, it may still not arrive");
    assert.equal(byTxid[spendOfIncoming.txid].state, "unconfirmed", "its parent isn't trusted");
  });

  test("Slot 24's History shows the net change per asset; an amount of the wallet's that's confidential is said not to be shown", async () => {
    const spendTxid = "e1".repeat(32);
    const receiveTxid = "e0".repeat(32);
    const confirmedAt = { confirmed: true, block_height: 2001, block_hash: "00".repeat(32), block_time: 1792000600 };
    const received = {
      txid: receiveTxid,
      vin: [{ txid: "d0".repeat(32), vout: 0, prevout: { scriptpubkey: FOREIGN, value: 200000, asset: POLICY_ASSET }, is_coinbase: false }],
      vout: [
        { scriptpubkey: addressScript(RECEIVE_0), value: 150000, asset: POLICY_ASSET },
        { scriptpubkey: addressScript(RECEIVE_1), value: 7, asset: OTHER_ASSET },
        // Blinded: commitments, no value or asset.
        { scriptpubkey: addressScript(RECEIVE_1), valuecommitment: "08" + "11".repeat(32), assetcommitment: "0a" + "22".repeat(32) },
        { scriptpubkey: "", value: 300, asset: POLICY_ASSET },
      ],
      status: { confirmed: true, block_height: 2000, block_hash: "00".repeat(32), block_time: 1792000000 },
    };
    const spend = {
      txid: spendTxid,
      vin: [{ txid: receiveTxid, vout: 0, prevout: { scriptpubkey: addressScript(RECEIVE_0), value: 150000, asset: POLICY_ASSET }, is_coinbase: false }],
      vout: [
        { scriptpubkey: FOREIGN, value: 100000, asset: POLICY_ASSET },
        { scriptpubkey: addressScript(CHANGE_0), value: 49700, asset: POLICY_ASSET },
        { scriptpubkey: "", value: 300, asset: POLICY_ASSET },
      ],
      status: confirmedAt,
    };
    ESPLORA.addressTxs = { [RECEIVE_0]: [spend, received], [RECEIVE_1]: [received], [CHANGE_0]: [spend] };
    try {
      const shown = await readHistory(session, "24");
      assert.equal(shown.error, undefined);
      assert.deepEqual(shown.entries.map((e) => e.txid), [spendTxid, receiveTxid]);
      const [out, into] = shown.entries;
      assert.deepEqual(out.amounts, ["−0.001003 ECX"]);
      assert.equal(out.hidden, undefined);
      assert.deepEqual(into.amounts.map((a) => a.split(" ")[0]), ["+0.0015", "+7"]);
      assert.match(into.amounts[1], /^\+7 Unknown asset$/, "an asset the Chain Entry doesn't name");
      assert.equal(into.hidden, "+ confidential amounts not shown");
    } finally {
      delete ESPLORA.addressTxs;
    }
  });

  test("a transaction whose input of the wallet's issues an asset is labelled an issuance, or a reissuance, not to yourself", async () => {
    const coin = { scriptpubkey: addressScript(RECEIVE_0), value: 100000, asset: POLICY_ASSET };
    const issuing = (seed, issuance) => ({
      txid: seed.repeat(32),
      vin: [{ txid: "a1".repeat(32), vout: 0, prevout: coin, is_coinbase: false, issuance }],
      vout: [
        { scriptpubkey: addressScript(RECEIVE_0), value: 1000, asset: OTHER_ASSET },
        { scriptpubkey: addressScript(CHANGE_0), value: 99966, asset: POLICY_ASSET },
        { scriptpubkey: "", value: 34, asset: POLICY_ASSET },
      ],
      status: { confirmed: false },
    });
    const issuance = issuing("e3", { asset_id: OTHER_ASSET, is_reissuance: false, assetamount: 1000 });
    const reissuance = issuing("e4", { asset_id: OTHER_ASSET, is_reissuance: true, assetamount: 1000 });
    ESPLORA.addressTxs = { [RECEIVE_0]: [issuance, reissuance], [CHANGE_0]: [issuance, reissuance] };
    try {
      const shown = await readHistory(session, "24");
      assert.deepEqual(shown.entries.map((e) => [e.txid, e.label]).sort(), [
        [issuance.txid, "Asset issuance"],
        [reissuance.txid, "Asset reissuance"],
      ]);
    } finally {
      delete ESPLORA.addressTxs;
    }
  });

  test("a Deposit's credit on Slot 24 (an input with is_pegin) is labelled as one, names the main-chain Deposit, and says the operator credited it", async () => {
    const depositTxid = "9d".repeat(32);
    const credit = {
      txid: "e2".repeat(32),
      vin: [{ txid: depositTxid, vout: 0, prevout: null, is_coinbase: false, is_pegin: true }],
      vout: [{ scriptpubkey: addressScript(RECEIVE_0), value: 100000, asset: POLICY_ASSET }],
      status: { confirmed: false },
    };
    ESPLORA.addressTxs = { [RECEIVE_0]: [credit] };
    try {
      const [entry] = (await readHistory(session, "24")).entries;
      assert.equal(entry.label, "Deposit from the main chain");
      assert.deepEqual(entry.amounts, ["+0.001 ECX"]);
      assert.equal(entry.state, "unconfirmed");
      assert.equal(entry.warning, "Credited by the chain's operator, not in a block yet");

      const page = await openActivity(session, "24");
      await page.waitForSelector(`[data-history-entry="${credit.txid}"]`, { timeout: 20_000 });
      await page.click(`[data-history-entry="${credit.txid}"]`);
      await page.waitForSelector("[data-activity-details]");
      const from = await page.evaluate(() => document.querySelector("[data-details-deposit-from]")?.textContent.trim());
      await closeSettled(page);
      assert.equal(from, depositTxid);
    } finally {
      delete ESPLORA.addressTxs;
    }
  });

  test("when an address has more transactions than the wallet reads pages of, the list says older ones may not be shown", async () => {
    // Esplora lists 25 confirmed at once; the wallet reads HISTORY_PAGES older pages, then stops.
    const read = 25 * (HISTORY_PAGES + 1);
    L1.txs = Array.from({ length: read + 1 }, (_, i) =>
      tx(i.toString(16).padStart(2, "0"), [{ value: 1025 - read + i, script: addressScript(L1_RECEIVE_0) }], { blockHeight: 970000 + i }),
    );
    const shown = await readHistory(session, "l1");
    assert.equal(shown.entries.length, read, "the latest pages, newest first");
    assert.deepEqual(shown.entries[0].amounts, ["+0.00001025 ECX"]);
    assert.equal(shown.more, "Older Main chain transactions may not be shown.");
  });

  test("with no transactions, it says so", async () => {
    const shown = await readHistory(session, "l1");
    assert.equal(shown.error, undefined);
    assert.deepEqual(shown.entries, []);
    assert.equal(shown.empty, "No transactions yet.");
  });

  test("it shows this session's last history at once while refreshing; if the refresh fails, it keeps it and says why", async () => {
    const received = tx("c7", [{ value: 40000, script: addressScript(L1_RECEIVE_0) }]);
    L1.txs = [received];
    await readHistory(session, "l1"); // now remembered
    L1.delayMs = 1500;
    L1.addressTxs = { [L1_RECEIVE_0]: { not: "a list" } };
    try {
      const page = await openActivity(session, "l1");
      await page.waitForSelector("[data-activity][data-refreshing] [data-history-entry]", { timeout: 10_000 });
      assert.match(await page.$eval("[data-activity] [data-read-at]", (e) => e.textContent.replace(/\s+/g, " ").trim()), /^Main chain: last read at .+; refreshing…$/);
      await page.waitForSelector("[data-activity]:not([data-refreshing])", { timeout: 20_000 });
      const shown = await page.evaluate(() => ({
        error: document.querySelector("[data-history-error]")?.textContent.replace(/\s+/g, " ").trim(),
        entries: [...document.querySelectorAll("[data-history-entry]")].map((e) => e.getAttribute("data-history-entry")),
      }));
      await closeSettled(page);
      assert.deepEqual(shown.entries, [received.txid]);
      assert.match(shown.error, /^Couldn't refresh Main chain activity: The Sidechain Server at .+ sent a malformed list of transactions\. Retry$/);
    } finally {
      L1.delayMs = 0;
      delete L1.addressTxs;
    }
  });

  test("home's Activity tab merges every chain's transactions, newest first, with chips to show one chain", async () => {
    const onMain = tx("c8", [{ value: 40000, script: addressScript(L1_RECEIVE_0) }], { blockTime: 1792000000 });
    L1.txs = [onMain];
    const onElements = {
      txid: "e5".repeat(32),
      vin: [{ txid: "d5".repeat(32), vout: 0, prevout: { scriptpubkey: FOREIGN, value: 9000, asset: POLICY_ASSET }, is_coinbase: false }],
      vout: [{ scriptpubkey: addressScript(RECEIVE_0), value: 8000, asset: POLICY_ASSET }, { scriptpubkey: "", value: 1000, asset: POLICY_ASSET }],
      status: { confirmed: true, block_height: 2002, block_hash: "00".repeat(32), block_time: 1792000600 },
    };
    ESPLORA.addressTxs = { [RECEIVE_0]: [onElements] };
    try {
      const shown = await readHistory(session, "home");
      assert.deepEqual(
        shown.entries.map((e) => [e.chain, e.txid, e.amounts]),
        [
          ["24", onElements.txid, ["+0.00008 ECX"]],
          ["l1", onMain.txid, ["+0.0004 ECX"]],
        ],
        "both chains, the newer first",
      );
      assert.equal(shown.days.length, 1, "both on the same day");

      const page = await openActivity(session, "home");
      await page.waitForSelector("[data-activity]:not([data-refreshing])", { timeout: 20_000 });
      const chips = await page.$$eval("[data-chip]", (c) => c.map((e) => e.textContent.trim()));
      assert.deepEqual(chips, ["All", "Main chain", "Elements+"]);
      await page.click('[data-chip="24"]');
      await waitForFunction(page, () => document.querySelectorAll("[data-history-entry]").length === 1);
      assert.equal(await page.$eval("[data-history-entry]", (e) => e.getAttribute("data-history-chain")), "24");
      await homeSettled(page);
      await page.close();
    } finally {
      delete ESPLORA.addressTxs;
    }
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
