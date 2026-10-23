// Seam 1, `suggestAsset` (docs/adr/0010): a Sidechain App with a Grant for it suggests a name for an
// asset, by its contract (checked against the chain before the user sees it) or as a plain name. The
// user approves or rejects it in the approval window. A plain name is stored as the app's, marked
// "named by <origin>"; a checked contract as from its contract. Whatever can refuse it does so
// before a window opens: no Grant, a contract that isn't the asset's, a ticker of the Chain Entry's,
// a plain name for an asset its contract already names.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, WALLET_PASSWORD, launchWallet, openTestApp, openWalletPage, serveEsplora, serveL1Esplora, serveTestApp, setUpWallet } from "../harness.mjs";

const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
const USDT = "ce091c998b83c78bb71a632313ba3760f1763d9cfcffae02258ffa9865a37bd2";
const USDT_CONTRACT =
  '{"entity":{"domain":"tether.to"},"issuer_pubkey":"0337cceec0beea0232ebe14cba0197a9fbd45fcf2ec946749de920e71434c2b904","name":"Tether USD","precision":8,"ticker":"USDt","version":0}';
const POINTS = "44".repeat(32);
const MINE = "55".repeat(32);
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";

const L1 = { identityBlock: L1_FORK_BLOCK, txs: [] };
const ESPLORA = {
  identityBlock: { height: 0, hash: GENESIS },
  assets: { [USDT]: { issuance_prevout: { txid: "9596d259270ef5bac0020435e6d859aea633409483ba64e232b8ba04ce288668", vout: 0 } } },
  // The wallet holds 12,345 base units of POINTS, 500 of them not yet confirmed.
  utxos: {
    [RECEIVE_0]: [
      { txid: "e0".repeat(32), vout: 0, value: 11_845, asset: POINTS, confirmed: true },
      { txid: "e1".repeat(32), vout: 0, value: 500, asset: POINTS, confirmed: false },
    ],
  },
};

/** The approval window's suggestion, as a user reads it. */
const readPrompt = (approval) =>
  approval.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    return {
      origin: text(document.querySelector("[data-origin]")),
      ticker: text(document.querySelector("[data-suggested-ticker]")),
      name: text(document.querySelector("[data-suggested-name]")),
      id: text(document.querySelector("[data-suggested-id]")),
      checked: document.querySelector("[data-suggested-checked]") !== null,
      unchecked: document.querySelector("[data-suggested-unchecked]") !== null,
      replaces: text(document.querySelector("[data-suggested-replaces]")) ?? null,
      balance: text(document.querySelector("[data-suggested-balance]")),
    };
  });

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let app;
  let page;
  let stubs;
  let origin;
  before(async () => {
    let l1, slot;
    [session, app, l1, slot] = await Promise.all([launchWallet(browserName), serveTestApp(), serveL1Esplora(L1), serveEsplora(ESPLORA)]);
    stubs = [l1, slot];
    await setUpWallet(session);
    page = await openTestApp(session, app, "dex.localhost");
    origin = app.origin("dex.localhost");
    const connecting = page.evaluate(() => window.testApp.request("connect", { slots: [24], methods: ["suggestAsset"] }));
    await (await session.waitForApprovalWindow()).click("[data-approve]");
    assert.ok((await connecting).result, "connected");
  });
  after(async () => {
    await session?.close();
    await app?.close();
    for (const stub of stubs ?? []) await stub.close();
  });

  const suggest = (params) => page.evaluate((p) => window.testApp.request("suggestAsset", { slot: 24, ...p }), params);
  /** The store's entries for Slot 24, as the Assets screen's background call answers them. */
  const stored = async () => {
    const wallet = await openWalletPage(session, "#/assets");
    const answer = await wallet.evaluate(() => chrome.runtime.sendMessage({ kind: "assets.list", slot: 24 }));
    const marks = await wallet.$$eval("[data-stored-asset]", (all) =>
      Object.fromEntries(all.map((e) => [e.getAttribute("data-stored-asset"), e.querySelector("[data-stored-source]").textContent.trim()])),
    );
    await wallet.close();
    return { entries: Object.fromEntries(answer.result.map((a) => [a.id, a])), marks };
  };

  test("without a Grant for suggestAsset, an app is refused with 4100 and no window", async () => {
    const other = await openTestApp(session, app, "other.localhost");
    const answer = await other.evaluate(() =>
      window.testApp.request("suggestAsset", { slot: 24, asset: "66".repeat(32), label: { name: "Spam", ticker: "SPAM", precision: 0 } }),
    );
    assert.equal(answer.error?.code, 4100);
    assert.equal((await session.approvalWindows()).length, 0);
    await other.close();
  });

  test("a plain name, approved, is stored as the app's and marked as named by it", async () => {
    const answer = suggest({ asset: POINTS, label: { name: "DEX points", ticker: "DXP", precision: 2 } });
    const approval = await session.waitForApprovalWindow();
    assert.deepEqual(await readPrompt(approval), {
      origin,
      ticker: "DXP",
      name: "DEX points",
      id: POINTS,
      checked: false,
      unchecked: true,
      replaces: null,
      balance: "You hold 118.45 DXP, +5 DXP unconfirmed.",
    });
    await approval.click("[data-approve]");
    assert.deepEqual(await answer, { result: { id: POINTS, name: "DEX points", ticker: "DXP", precision: 2, source: "app", origin } });
    const { marks } = await stored();
    assert.equal(marks[POINTS], `named by ${origin}`);
  });

  test("a rejected suggestion answers 4001 and stores nothing", async () => {
    const answer = suggest({ asset: MINE, label: { name: "Mine", ticker: "MINE", precision: 0 } });
    await (await session.waitForApprovalWindow()).click("[data-reject]");
    assert.equal((await answer).error?.code, 4001);
    assert.equal((await stored()).entries[MINE], undefined);
  });

  test("a contract is checked against the chain before the user sees it, and stored as from its contract", async () => {
    const answer = suggest({ asset: USDT, contract: USDT_CONTRACT });
    const approval = await session.waitForApprovalWindow();
    const shown = await readPrompt(approval);
    assert.deepEqual([shown.ticker, shown.name, shown.checked], ["USDt", "Tether USD", true]);
    await approval.click("[data-approve]");
    assert.equal((await answer).result?.source, "contract");
    const { entries, marks } = await stored();
    assert.equal(entries[USDT].origin, origin, "the app that suggested it is kept");
    assert.equal(marks[USDT], "from its contract");
  });

  test("a contract that isn't the asset's, a ticker of the chain's own, or a plain name over a contract's is refused without a window", async () => {
    const refusals = [
      [{ asset: USDT, contract: USDT_CONTRACT.replace("Tether USD", "Tether USD2") }, /isn't the one asset/],
      [{ asset: MINE, label: { name: "Fake eCash", ticker: "Ecx", precision: 8 } }, /ticker Ecx is taken/],
      [{ asset: USDT, label: { name: "Tether", ticker: "TTHR", precision: 8 } }, /already names asset .* from its contract/],
      [{ asset: MINE }, /exactly one of `contract` or `label`/],
    ];
    for (const [params, message] of refusals) {
      const answer = await suggest(params);
      assert.equal(answer.error?.code, -32602, JSON.stringify(params));
      assert.match(answer.error.message, message);
    }
    assert.equal((await session.approvalWindows()).length, 0);
  });

  test("a suggestion for an asset already named says what it replaces", async () => {
    const answer = suggest({ asset: POINTS, label: { name: "DEX points v2", ticker: "DXP2", precision: 2 } });
    const approval = await session.waitForApprovalWindow();
    assert.match((await readPrompt(approval)).replaces, /^Replaces its current name, DXP \(DEX points\), named by /);
    await approval.click("[data-approve]");
    assert.equal((await answer).result?.ticker, "DXP2");
  });

  test("an app can have one suggestion waiting at a time: another meanwhile is refused with -32002", async () => {
    const first = suggest({ asset: MINE, label: { name: "Mine", ticker: "MINE", precision: 0 } });
    const approval = await session.waitForApprovalWindow();
    const second = await suggest({ asset: "66".repeat(32), label: { name: "Other", ticker: "OTHR", precision: 0 } });
    assert.equal(second.error?.code, -32002);
    await approval.click("[data-reject]");
    assert.equal((await first).error?.code, 4001);
  });

  test("while locked, the suggestion still opens, without asking to unlock, and says the balance isn't shown", async () => {
    const wallet = await openWalletPage(session, "#/settings");
    await wallet.evaluate(() => chrome.runtime.sendMessage({ kind: "vault.lock" }));
    try {
      const answer = suggest({ asset: MINE, label: { name: "Mine", ticker: "MINE", precision: 0 } });
      const approval = await session.waitForApprovalWindow();
      assert.equal(await approval.$("[data-unlock-required]"), null, "no unlock step");
      assert.equal((await readPrompt(approval)).balance, "Your balance isn't shown while the wallet is locked.");
      await approval.click("[data-reject]");
      assert.equal((await answer).error?.code, 4001);
    } finally {
      await wallet.evaluate((password) => chrome.runtime.sendMessage({ kind: "vault.unlock", password }), WALLET_PASSWORD);
      await wallet.close();
    }
  });
});
