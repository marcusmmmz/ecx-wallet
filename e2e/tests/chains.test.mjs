// Seam 1: chains on and off. The main chain is always on; a sidechain is off on a fresh install,
// hidden and never read from its server until the user, or an app with the user's approval, turns
// it on. Turning one off hides it; the funds on it stay where they are.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  BROWSERS,
  homeSettled,
  launchWallet,
  openTestApp,
  openWalletPage,
  serveEsplora,
  serveL1Esplora,
  serveTestApp,
  setUpWallet,
  turnOnChain,
} from "../harness.mjs";

const GENESIS = "a7754ce0debc40baddbd8c47e79d19209685f22c63edaaf8b69cf54116374d7f";
const POLICY_ASSET = "5836dcc06130dcf6a65b6ac493813fd65559955283e44cc3f07966294eccb2c8";
const RECEIVE_0 = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
const L1_FORK_BLOCK = { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" };
const L1_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

const ESPLORA = {
  identityBlock: { height: 0, hash: GENESIS },
  utxos: { [RECEIVE_0]: [{ txid: "a0".repeat(32), vout: 0, value: 150000, asset: POLICY_ASSET, confirmed: true }] },
};
const L1_ESPLORA = { identityBlock: L1_FORK_BLOCK, utxos: { [L1_RECEIVE_0]: [{ txid: "b0".repeat(32), vout: 0, value: 100000, confirmed: true }] } };

/** Opens home and waits until it has settled. */
async function openHome(session) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector('[data-vault-state="unlocked"]', { timeout: 10_000 });
  await homeSettled(page);
  return page;
}

/** Home's sections and total, once settled. */
async function readHome(session) {
  const page = await openHome(session);
  const shown = await page.evaluate(() => ({
    sections: [...document.querySelectorAll("[data-account]")].map((e) => e.getAttribute("data-account")),
    label: document.querySelector("[data-total]").previousElementSibling.textContent.trim(),
    total: document.querySelector("[data-total]").textContent.trim(),
  }));
  await page.close();
  return shown;
}

/** The Chains screen's rows: [chain, switched on (or "always")]. */
async function readChains(page) {
  return page.$$eval("[data-chain]", (rows) =>
    rows.map((r) => [r.getAttribute("data-chain"), r.querySelector("[data-always-on]") ? "always" : r.querySelector("[role=switch]").getAttribute("aria-checked")]),
  );
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let stub;
  let l1Stub;
  let app;
  before(async () => {
    [session, stub, l1Stub, app] = await Promise.all([launchWallet(browserName), serveEsplora(ESPLORA), serveL1Esplora(L1_ESPLORA), serveTestApp()]);
    await setUpWallet(session, { on: [] });
  });
  after(async () => {
    await session?.close();
    await stub?.close();
    await l1Stub?.close();
    await app?.close();
  });

  test("on a fresh install only the main chain shows, and nothing asks the sidechain's server", async () => {
    const { sections, label, total } = await readHome(session);
    assert.deepEqual(sections, ["l1"]);
    assert.equal(label, "Balance", "one chain: no total across chains");
    assert.equal(total, "0.001 ECX");
    const page = await openHome(session);
    await page.click("[data-deposit-action]");
    await page.waitForSelector("[data-deposit-sheet]");
    assert.equal(await page.$eval("[data-no-sidechains]", (e) => e.textContent.trim()), "Turn on a sidechain to deposit to it.");
    await page.close();

    const ask = await openWalletPage(session, "#/grants");
    const answer = await ask.evaluate(() => chrome.runtime.sendMessage({ kind: "accounts.reported", slot: 24 }));
    assert.equal(answer.error?.message, "Elements+ is turned off.");
    await ask.close();
    assert.deepEqual(stub.requests(), [], "Slot 24's server was never asked");
  });

  test("the Chains screen lists every chain this release supports; turning one on shows it on home", async () => {
    const page = await openWalletPage(session, "#/chains");
    assert.deepEqual(await readChains(page), [["l1", "always"], ["24", "false"], ["99", "false"]], "Flush starts off too");
    await page.click('[data-chain-switch="24"]');
    await page.waitForSelector('[data-chain-switch="24"][aria-checked="true"]', { timeout: 10_000 });
    await page.close();

    const home = await readHome(session);
    assert.deepEqual(home.sections, ["l1", "24"]);
    assert.equal(home.label, "Total across chains");
    assert.equal(home.total, "0.0025 ECX");
  });

  test("turning off a chain that holds ECX asks first; kept on, nothing changes; turned off, it's hidden", async () => {
    const page = await openWalletPage(session, "#/chains");
    await page.click('[data-chain-switch="24"]');
    await page.waitForSelector("[data-turn-off-sheet]", { timeout: 20_000 });
    assert.equal(
      await page.$eval("[data-turn-off-holds]", (e) => e.textContent.trim()),
      "Your 0.0015 ECX on Elements+ stays there. It's hidden until you turn the chain back on.",
    );
    await page.click("[data-keep-on]");
    assert.equal(await page.$('[data-chain-switch="24"][aria-checked="true"]') !== null, true);
    await page.click('[data-chain-switch="24"]');
    await page.waitForSelector("[data-turn-off]", { timeout: 20_000 });
    await page.click("[data-turn-off]");
    await page.waitForSelector('[data-chain-switch="24"][aria-checked="false"]', { timeout: 10_000 });
    await page.close();

    const home = await readHome(session);
    assert.deepEqual(home.sections, ["l1"]);
  });

  test("the bottom bar is on every screen of an unlocked wallet: Chains opens the Chains screen, Activity home's panel", async () => {
    const home = await openHome(session);
    assert.equal(await home.$("[data-manage-chains]"), null, "no Manage chains card: the bar has Chains");
    await home.click('[data-nav="chains"]');
    await home.waitForSelector("[data-chains] [data-chain-switch]", { timeout: 10_000 });
    assert.equal(await home.$eval('[data-nav="chains"]', (e) => e.getAttribute("aria-current")), "page");
    await home.click('[data-nav="activity"]');
    await home.waitForSelector('[data-tab="activity"][aria-selected="true"]', { timeout: 10_000 });
    assert.equal(await home.$eval("[data-activity]", (e) => e.closest("[hidden]") === null), true, "home opened on Activity");
    // Coming back, home reads every chain again: closing it before those answer is a Firefox runtime error.
    await homeSettled(home);
    await home.close();
  });

  test("an app connecting for a chain that's off: its prompt says approving turns it on, and approving does", async () => {
    const page = await openTestApp(session, app, "chains.localhost");
    const connecting = page.evaluate(() => window.testApp.request("connect", { slots: [24], methods: ["getAddresses"] }));
    const approval = await session.waitForApprovalWindow();
    await approval.waitForSelector("[data-turns-on]");
    assert.match(await approval.$eval("[data-turns-on]", (e) => e.textContent.trim()), /^Approving also turns on Elements\+, which you have off/);
    await approval.click("[data-approve]");
    assert.ok((await connecting).result, "connected");
    await page.close();
    assert.deepEqual((await readHome(session)).sections, ["l1", "24"]);
  });

  test("an app asking for addresses on a chain that's off asks to turn it on; kept off, the app gets 4001", async () => {
    const settle = await openWalletPage(session, "#/grants");
    await turnOnChain(settle, 24, false);
    await settle.close();
    const page = await openTestApp(session, app, "chains.localhost");
    const asking = page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    const approval = await session.waitForApprovalWindow();
    await approval.waitForSelector("[data-turn-on]");
    assert.equal(await approval.$eval("h1", (e) => e.textContent.trim()), "Turn on Elements+?");
    await approval.click("[data-reject]");
    assert.equal((await asking).error?.code, 4001);
    await page.close();
    assert.deepEqual((await readHome(session)).sections, ["l1"], "still off");
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
