// Seam 1: the Slot 24 receive address, in the home page's Receive sheet and through the Provider.
//
// The wallet imports "abandon … about" with no passphrase. Its Slot 24 Starter is a BitWindow
// vector and the address below was computed from that Starter independently (see
// core/elements/tests/elements.rs), so seeing it proves the address came from the Slot 24 Starter.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, homeSettled, launchWallet, openTestApp, openWalletPage, serveTestApp, setUpWallet, WALLET_PASSWORD } from "../harness.mjs";

const SLOT_24_ADDRESS = "elements1qew44aehkjstjm56ng2rjrz57vwxh5g9su6dlpm";
/** The key that address pays (its p2wpkh is checked in core/elements/tests/elements.rs). */
const SLOT_24_PUBLIC_KEY = "03cb6668b63d283f844f58387399eec95413928b545118ff4c57e5bac2f1562603";
const SLOT_24_ENTRY = { chain: "ecash:betanet-s24", address: SLOT_24_ADDRESS, publicKey: SLOT_24_PUBLIC_KEY };
/** BIP84's own vector for "abandon … about", m/84'/0'/0'/0/0 (bip-0084.mediawiki). */
const L1_ADDRESS = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";

/** Opens home's Receive sheet, which lists every chain's address. */
async function openReceive(session) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector("[data-receive-action]", { timeout: 10_000 });
  await page.click("[data-receive-action]");
  await page.waitForSelector("[data-receive-sheet]");
  return page;
}

async function typeInto(page, selector, text) {
  await page.$eval(selector, (e) => (e.value = ""));
  await page.type(selector, text);
}

/** Connects `host`'s test app with `scope`, approving the prompt. */
async function connect(session, app, host, scope) {
  const page = await openTestApp(session, app, host);
  const connecting = page.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  assert.ok((await connecting).result, "connected");
  return page;
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let app;
  before(async () => {
    [session, app] = await Promise.all([launchWallet(browserName), serveTestApp()]);
    await setUpWallet(session); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  /** Unfolds `account`'s row in the Receive sheet; returns what it shows. */
  async function unfold(page, account) {
    const row = `[data-receive-sheet] [data-account="${account}"]`;
    await page.waitForSelector(`${row} [data-qr-toggle]`, { timeout: 20_000 });
    await page.click(`${row} [data-qr-toggle]`);
    await page.waitForSelector(`${row} [data-qr]`);
    return page.$eval(row, (e) => ({
      short: e.querySelector("[data-short-address]").textContent.trim(),
      address: e.querySelector("[data-receive-address]").textContent.trim(),
      qr: e.querySelector("[data-qr]").getAttribute("data-qr"),
      chain: e.querySelector("[data-account-chain]").textContent.trim(),
      unfolded: [...document.querySelectorAll("[data-receive-sheet] [data-qr]")].length,
    }));
  }

  test("Receive shows the Slot 24 receive address in elements… encoding, and its QR code", async () => {
    const page = await openReceive(session);
    const shown = await unfold(page, "24");
    assert.equal(shown.address, SLOT_24_ADDRESS);
    assert.equal(shown.qr, SLOT_24_ADDRESS, "the QR code is of the address shown (tests/qr.test scans one back)");
    assert.equal(shown.short, "elements1qew…9su6dlpm", "the row shows its two ends");
    assert.equal(shown.chain, "ecash:betanet-s24");
    await page.close();
  });

  test("Receive shows the main chain's receive address, BIP84's m/84'/0'/0'/0/0, above the Slots; one QR code at a time", async () => {
    const page = await openReceive(session);
    await unfold(page, "24");
    const shown = await unfold(page, "l1");
    assert.equal(shown.address, L1_ADDRESS);
    assert.equal(shown.qr, L1_ADDRESS);
    assert.equal(shown.chain, "ecash:betanet");
    assert.equal(shown.unfolded, 1, "unfolding one folds the other");
    const order = await page.$$eval("[data-receive-sheet] [data-account]", (rows) => rows.map((r) => r.getAttribute("data-account")));
    assert.deepEqual(order, ["l1", "24"]);
    await page.close();
  });

  test("a chain's own screen opens Receive on its QR code", async () => {
    const page = await openWalletPage(session, "#/chain/24");
    await page.click("[data-receive-action]");
    await page.waitForSelector('[data-receive-sheet] [data-account="24"] [data-qr]', { timeout: 20_000 });
    assert.deepEqual(await page.$$eval("[data-receive-sheet] [data-account]", (rows) => rows.map((r) => r.getAttribute("data-account"))), ["24"]);
    await page.close();
  });

  test("getAddresses returns the Slot 24 address and its public key to an origin whose Grant covers Slot 24", async () => {
    const page = await connect(session, app, "addresses.localhost", { slots: [24], methods: ["getAddresses"] });
    const answer = await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    assert.deepEqual(answer, { result: [SLOT_24_ENTRY] });
    await page.close();
  });

  test("getAddresses fails with 4100 for an origin whose Grant doesn't cover Slot 24", async () => {
    const page = await connect(session, app, "other-slot.localhost", { slots: [9], methods: ["getAddresses"] });
    const answer = await page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    assert.equal(answer.error?.code, 4100);
    await page.close();
  });

  test("getAddresses while locked: getGrant says so, closing the unlock window is 4001, and unlocking there answers", async () => {
    const page = await connect(session, app, "locked.localhost", { slots: [24], methods: ["getAddresses"] });
    const home = await session.openPage("index.html#/");
    await home.waitForSelector("[data-lock]", { timeout: 10_000 });
    await homeSettled(home);
    await home.click("[data-lock]");
    await home.waitForSelector('[data-vault-state="locked"]');
    await home.close();
    const grant = await page.evaluate(() => window.testApp.request("getGrant"));
    assert.equal(grant.result?.unlocked, false, "a page can check before asking, so a reload needn't open a window");

    const refused = page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));
    const closing = await session.waitForApprovalWindow();
    await closing.waitForSelector("[data-unlock-required]");
    await closing.close();
    assert.equal((await refused).error?.code, 4001);

    // Two at once share one window.
    const asking = page.evaluate(() => Promise.all([0, 1].map(() => window.testApp.request("getAddresses", { slot: 24 }))));
    const approval = await session.waitForApprovalWindow();
    await approval.waitForSelector("[data-unlock-required]");
    await typeInto(approval, "[data-password]", WALLET_PASSWORD);
    await approval.click("[data-unlock]");
    const expected = { result: [SLOT_24_ENTRY] };
    assert.deepEqual(await asking, [expected, expected]);
    assert.equal((await page.evaluate(() => window.testApp.request("getGrant"))).result?.unlocked, true);
    await page.close();
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
