// Seam 1: create, import, lock and unlock the wallet, driven through the wallet's own pages in a
// real browser. Each test gets a fresh browser profile (a profile holds at most one wallet).
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { BROWSERS, homeSettled, launchWallet, openWalletPage, waitForFunction } from "../harness.mjs";

const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PASSPHRASE = "ecx-e2e-passphrase-Q7";
const PASSWORD = "correct horse battery";

/** Opens a wallet page (`route` is the hash route, e.g. "create") once it has rendered. */
async function openWallet(session, route = "") {
  const page = await session.openPage(`index.html#/${route}`);
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  return page;
}

/** Which state the home page shows: "onboarding", "locked" or "unlocked". */
async function homeState(session) {
  const page = await openWallet(session);
  const state = await page.$eval("[data-vault-state]", (e) => e.dataset.vaultState);
  if (state === "unlocked") await homeSettled(page);
  await page.close();
  return state;
}

async function typeInto(page, selector, text) {
  await page.$eval(selector, (e) => (e.value = ""));
  await page.type(selector, text);
}

async function importWallet(session, { phrase = PHRASE, passphrase = PASSPHRASE, password = PASSWORD } = {}) {
  const page = await openWallet(session, "import");
  await typeInto(page, "[data-import-phrase]", phrase);
  if (passphrase) await typeInto(page, "[data-import-passphrase]", passphrase);
  await typeInto(page, "[data-new-password]", password);
  await typeInto(page, "[data-repeat-password]", password);
  await page.click("[data-submit]");
  return page;
}

/** Imports PHRASE (with PASSPHRASE) and waits until the wallet shows as unlocked. */
async function setUpWallet(session) {
  const page = await importWallet(session);
  await page.waitForSelector('[data-vault-state="unlocked"]');
  await homeSettled(page);
  await page.close();
}

async function unlock(page, password) {
  await typeInto(page, "[data-password]", password);
  await page.click("[data-unlock]");
}

/** Text a user could read on the page, plus every form field's value. */
const visibleText = (page) =>
  page.evaluate(() => [document.body.innerText, ...[...document.querySelectorAll("input, textarea")].map((e) => e.value)].join("\n"));

for (const browserName of BROWSERS) describe(browserName, () => {
  async function withWallet(fn) {
    const session = await launchWallet(browserName);
    try {
      await fn(session);
    } finally {
      await session.close();
    }
  }

  test("a new browser profile starts at onboarding", () =>
    withWallet(async (session) => {
      assert.equal(await homeState(session), "onboarding");
    }));

  test("create: the phrase is shown once, some of its words must be confirmed, then the wallet is unlocked", () =>
    withWallet(async (session) => {
      const page = await openWallet(session, "create");
      const words = await page.$$eval("[data-phrase] [data-word]", (es) => es.map((e) => e.textContent.trim()));
      assert.equal(words.length, 12);
      assert.ok(words.every((w) => /^[a-z]+$/.test(w)), `words: ${words}`);
      await page.click("[data-phrase-saved]");

      // The phrase is gone from the screen; the user is asked for some of its words by position.
      await page.waitForSelector("[data-confirm-word]");
      assert.equal(await page.$("[data-phrase]"), null);
      const positions = await page.$$eval("[data-confirm-word]", (es) => es.map((e) => Number(e.dataset.confirmWord)));
      assert.ok(positions.length >= 2 && positions.length < 12, `asks for ${positions.length} words`);

      // A wrong word is refused.
      const [first, ...rest] = positions;
      await typeInto(page, `[data-confirm-word="${first}"]`, words[first - 1] === "zoo" ? "abandon" : "zoo");
      for (const n of rest) await typeInto(page, `[data-confirm-word="${n}"]`, words[n - 1]);
      await typeInto(page, "[data-new-password]", PASSWORD);
      await typeInto(page, "[data-repeat-password]", PASSWORD);
      await page.click("[data-submit]");
      await page.waitForSelector("[data-error]");
      assert.match(await page.$eval("[data-error]", (e) => e.textContent), /word/i);

      // The right words create the wallet and leave it unlocked.
      await typeInto(page, `[data-confirm-word="${first}"]`, words[first - 1]);
      await page.click("[data-submit]");
      await page.waitForSelector('[data-vault-state="unlocked"]');
      assert.equal(await homeState(session), "unlocked");

      // Shown once: nothing in the wallet shows the phrase again, and create isn't offered twice.
      for (const route of ["", "create"]) {
        const again = await openWallet(session, route);
        const text = await visibleText(again);
        assert.ok(!words.some((w, i) => i > 0 && text.includes(`${words[i - 1]} ${w}`)), `#/${route} shows the phrase`);
        await again.close();
      }
      await page.close();
    }));

  test("import: an invalid phrase is refused; a valid one with a passphrase opens the wallet unlocked", () =>
    withWallet(async (session) => {
      const bad = await importWallet(session, { phrase: "legal winner thank year wave sausage worth useful legal winner thank thank" });
      await bad.waitForSelector("[data-error]");
      assert.match(await bad.$eval("[data-error]", (e) => e.textContent), /Master Mnemonic/);
      await bad.close();
      assert.equal(await homeState(session), "onboarding");

      const page = await importWallet(session);
      await page.waitForSelector('[data-vault-state="unlocked"]');
      await page.close();
      assert.equal(await homeState(session), "unlocked");
    }));

  test("lock and unlock: the right password unlocks; a wrong one says only 'Incorrect password.'", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const page = await openWallet(session);
      await page.waitForSelector('[data-vault-state="unlocked"]');
      await page.click("[data-lock]");
      await page.waitForSelector('[data-vault-state="locked"]');
      assert.equal(await homeState(session), "locked");

      await unlock(page, "wrong password");
      await page.waitForSelector("[data-error]");
      assert.equal(await page.$eval("[data-error]", (e) => e.textContent.trim()), "Incorrect password.");
      assert.equal(await homeState(session), "locked");

      await unlock(page, PASSWORD);
      await page.waitForSelector('[data-vault-state="unlocked"]');
      assert.equal(await homeState(session), "unlocked");
      await page.close();
    }));

  /** Sets the auto-lock delay, then locks and unlocks; returns how long the wallet now stays unlocked (ms). */
  async function unlockedFor(page, minutes) {
    await page.evaluate((m) => chrome.runtime.sendMessage({ kind: "vault.setAutoLock", minutes: m }), minutes);
    await page.click("[data-lock]");
    await page.waitForSelector('[data-vault-state="locked"]');
    await unlock(page, PASSWORD);
    await page.waitForSelector('[data-vault-state="unlocked"]');
    return page.evaluate(async () => (await chrome.storage.session.get("vault:unlockedUntil"))["vault:unlockedUntil"] - Date.now());
  }

  test("the auto-lock delay is clamped to 1-15 minutes, so it can never be turned off", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const page = await openWallet(session);
      const near = (ms, minutes) => Math.abs(ms - minutes * 60_000) < 10_000;
      for (const [asked, expected] of [[0.025, 1], [0, 1], [-5, 1], [5, 5], [1e9, 15]]) {
        const ms = await unlockedFor(page, asked);
        assert.ok(near(ms, expected), `asked ${asked} min: unlocked for ${ms} ms, expected about ${expected} min`);
      }
      await page.close();
    }));

  test("the wallet locks itself once the auto-lock deadline passes without activity", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const page = await openWallet(session);
      await unlockedFor(page, 1);
      await homeSettled(page);
      assert.equal(await homeState(session), "unlocked");
      // Stand in for a minute without activity: bring the stored deadline forward to 1.5 s from now.
      await page.evaluate(() => chrome.storage.session.set({ "vault:unlockedUntil": Date.now() + 1_500 }));
      await new Promise((r) => setTimeout(r, 2_500));
      assert.equal(await homeState(session), "locked");
      await page.close();
    }));

  /** Moves the stored auto-lock deadline to `ms` from now, standing in for time passing without use. */
  const deadlineIn = (page, ms) => page.evaluate((ms) => chrome.storage.session.set({ "vault:unlockedUntil": Date.now() + ms }), ms);
  const deadlineLeft = (page) => page.evaluate(async () => (await chrome.storage.session.get("vault:unlockedUntil"))["vault:unlockedUntil"] - Date.now());

  test("the home page counts down to the auto-lock, following the deadline as it moves", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const page = await openWallet(session);
      await homeSettled(page);
      const countdown = () => page.$eval("[data-lock-countdown]", (e) => e.textContent.trim());
      assert.equal(await countdown(), "Locks in 15 min");
      await page.evaluate(() => chrome.runtime.sendMessage({ kind: "vault.setAutoLock", minutes: 3 }));
      await page.click('[data-tab="activity"]'); // a use: the deadline moves to 3 minutes from now
      await waitForFunction(page, () => document.querySelector("[data-lock-countdown]").textContent.trim() === "Locks in 3 min", { timeout: 10_000 });
      await page.close();
    }));

  test("the bottom bar leaves a screen other than home once the wallet locks", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const page = await openWalletPage(session, "#/chains");
      await page.waitForSelector("nav.bottom-bar", { timeout: 10_000 });
      // Locked from elsewhere (another window's Settings): this screen hears it, without navigating.
      const other = await openWalletPage(session, "#/settings");
      await other.evaluate(() => chrome.runtime.sendMessage({ kind: "vault.lock" }));
      await waitForFunction(page, () => document.querySelector("nav.bottom-bar") === null, { timeout: 10_000 });
      await other.close();
      await page.close();
    }));

  test("using a wallet page moves the auto-lock deadline back, at most once a minute; an untouched page doesn't", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const page = await openWallet(session);
      await homeSettled(page); // its reads derive keys, which count as use; nothing after
      await deadlineIn(page, 180_000);
      await new Promise((r) => setTimeout(r, 1_000));
      assert.ok((await deadlineLeft(page)) < 180_000, "an open page alone keeps nothing unlocked");

      await page.click('[data-tab="activity"]');
      await waitForFunction(
        page,
        async () => (await chrome.storage.session.get("vault:unlockedUntil"))["vault:unlockedUntil"] - Date.now() > 14 * 60_000,
        { timeout: 10_000 },
      );
      await waitForFunction(page, () => document.querySelector("[data-lock-countdown]").textContent.trim() === "Locks in 15 min", { timeout: 10_000 });
      // Opening Activity reads its history, whose keys count as use: let it finish first.
      await page.waitForSelector("[data-activity]:not([data-refreshing])", { timeout: 20_000 });

      await deadlineIn(page, 180_000);
      await page.click('[data-tab="assets"]');
      await new Promise((r) => setTimeout(r, 1_000));
      assert.ok((await deadlineLeft(page)) < 180_000, "a second use within the minute doesn't ask again");
      await page.close();
    }));

  test("Settings shows the auto-lock, switches the unit, links to Grants and locks now", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      const home = await openWallet(session);
      await homeSettled(home);
      await home.click("[data-settings-link]");
      await home.waitForSelector("[data-settings]");
      const text = (selector) => home.$eval(selector, (e) => e.textContent.replace(/\s+/g, " ").trim());
      assert.equal(await text("[data-auto-lock]"), "After 15 minutes without use");
      assert.equal(await home.$eval("[data-grants-link]", (e) => e.getAttribute("href")), "#/grants");

      assert.equal(await home.$eval('[data-unit-option="ecx"]', (e) => e.getAttribute("aria-pressed")), "true");
      await home.click('[data-unit-option="sats"]');
      await home.waitForSelector('[data-unit-option="sats"][aria-pressed="true"]');
      assert.equal(await home.evaluate(() => chrome.runtime.sendMessage({ kind: "settings.unit" }).then((r) => r.result)), "sats");

      await home.click("[data-lock-now]");
      await home.waitForSelector('[data-vault-state="locked"]', { timeout: 10_000 });
      assert.equal(await homeState(session), "locked");
      await home.close();
    }));

  test("nothing unencrypted that derives from the Master Mnemonic is in persistent storage", () =>
    withWallet(async (session) => {
      await setUpWallet(session);
      assert.equal(await homeState(session), "unlocked");
      const page = await openWallet(session);
      const stored = JSON.stringify(await page.evaluate(() => chrome.storage.local.get(null)));
      await page.close();
      assert.ok(stored.length > 0);
      for (const secret of ["legal winner", "winner thank", PASSPHRASE, PASSWORD]) {
        assert.ok(!stored.includes(secret), `storage.local contains ${secret}`);
      }
    }));
});

// Restarts: the background (Brave's service worker, Firefox's event page) is stopped the way the
// browser stops it when idle, and the browser is restarted on the same profile.
for (const browserName of BROWSERS) describe(`${browserName}: restarts`, () => {
  test("the wallet stays unlocked across a forced background restart", async () => {
    const session = await launchWallet(browserName);
    try {
      await setUpWallet(session);
      assert.equal(await homeState(session), "unlocked");
      assert.ok((await session.stopBackground()) > 0, "a running background was stopped");
      assert.equal(await homeState(session), "unlocked");
      // And the restarted background can still lock it.
      const page = await openWallet(session);
      await page.click("[data-lock]");
      await page.waitForSelector('[data-vault-state="locked"]');
      await page.close();
    } finally {
      await session.close();
    }
  });

  test("a browser restart leaves the wallet locked, and the profile on disk holds no plaintext secret", async () => {
    const profile = await mkdtemp(path.join(tmpdir(), `ecx-e2e-${browserName}-restart-`));
    try {
      const first = await launchWallet(browserName, { profile });
      try {
        await setUpWallet(first);
        assert.equal(await homeState(first), "unlocked");
      } finally {
        await first.close();
      }

      for (const file of await filesUnder(profile)) {
        const bytes = await readFile(file).catch(() => Buffer.alloc(0));
        for (const secret of ["legal winner thank", PASSPHRASE, PASSWORD]) {
          assert.ok(!bytes.includes(secret), `${path.relative(profile, file)} contains ${secret}`);
        }
      }

      const second = await launchWallet(browserName, { profile });
      try {
        assert.equal(await homeState(second), "locked");
        const page = await openWallet(second);
        await unlock(page, PASSWORD);
        await page.waitForSelector('[data-vault-state="unlocked"]');
        await page.close();
      } finally {
        await second.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

async function filesUnder(dir) {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}
