// Seam 1, phone width (#77): the wallet's pages at 360×740 with touch, as a phone shows them. They
// are drawn for the 400×600 popup, the side panel and a desktop tab; this checks that at a phone's
// width nothing scrolls sideways, the bottom bar stays on screen, no text is too small to read, and
// an approval's amounts show in full. Flush (Slot 99) gives every screen something to show, and its
// trades the approval's amounts. The Apps view is the web build's only, so it is checked there.
//
// Brave only: touch emulation (`isMobile`, `hasTouch`) is CDP's; Firefox's BiDi has none.
//
// Headless, `100dvh` and `100vh` are the same height (there is no URL bar to hide), so what this can
// check of the frame is that it is the screen's height: the dynamic part is the user's to see.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { encodeTx, parseTx } from "@ecx/stub-server/bitcoin-tx";
import {
  ABANDON,
  activitySettled,
  BROWSERS,
  DIST_E2E,
  homeSettled,
  importWallet,
  launchWallet,
  launchWebWallet,
  openTestApp,
  ROOT,
  serveFlushEsplora,
  serveL1Esplora,
  serveTestApp,
  serveWebWallet,
  setUpWallet,
  WALLET_PASSWORD,
  waitForFunction,
} from "../harness.mjs";
import { BROSEVELT, LIVE_TXS, REGISTRATION } from "../flush-sale.mjs";

const PHONE = { width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const POPUP = { width: 400, height: 600 };
/** The smallest text the wallet draws (0.7rem): anything smaller is too small to read on a phone. */
const SMALLEST_TEXT_PX = 11.2;

const wallet = await importWallet();
const [vault, flush] = await Promise.all([
  readFile(path.join(DIST_E2E.chromium, "vault.wasm")).then(wallet.loadVaultModule),
  readFile(path.join(DIST_E2E.chromium, "flush.wasm")).then(wallet.loadChainModule),
]);
const RECEIVE_0 = flush.deriveAccount(vault.starter(ABANDON, "", 99), { receive: 1 }).receive[0];
const FINAL = "f0".repeat(32);

/** 0.001 ECX to the wallet, so home, the chain and History have a row and Send a balance. */
const PAYMENT = encodeTx({ inputs: [{ txid: "e1".repeat(32), vout: 0 }], outputs: [{ value: 100_000, script: RECEIVE_0.scriptPubkey }] });

/** BROSEVELT, a live token on Slot 99 (2 decimals), and its concentrated pool with ECX (core/flush/tests). */
const TRADE = JSON.parse(await readFile(path.join(ROOT, "core/flush/tests/trade-fixtures.json"), "utf8"));
const BROSEVELT_POOL = TRADE.brosevelt.pool.pool;
/** A floor as long as a link's amount gets (15 whole digits, core/flush/src/link.rs), quoted exactly. */
const MIN_OUT = "999999999999999";

// `cors`: the web build's pages reach the stubs as plain pages; the extension doesn't mind it.
const FLUSH = {
  cors: true,
  identityBlock: flush.chainEntry().networks.betanet.identityBlock,
  tipHeight: 10_000,
  feeEstimates: { 1: 1, 6: 0.1, 1008: 0.1 },
  txs: [
    { hex: PAYMENT, blockHeight: 3200, blockHash: FINAL },
    { hex: LIVE_TXS[REGISTRATION], blockHeight: 604, blockHash: FINAL },
  ],
  utxos: { [RECEIVE_0.address]: [{ txid: parseTx(PAYMENT).txid, vout: 0, value: 100_000, confirmed: true, blockHash: FINAL }] },
  flushAssets: { [BROSEVELT]: { asset: BROSEVELT, registered: 604, registration: REGISTRATION } },
  flushRpc: {
    getswapquote: () => ({ pools: [{ pool: BROSEVELT_POOL, curve: "concentrated", amount_out: Number(MIN_OUT) }], best_pool: BROSEVELT_POOL }),
    getpool: ([id]) => (id === BROSEVELT_POOL ? TRADE.brosevelt.pool : undefined),
    getbitassetsinfo: { min_chn_payout: 0.00005, small_payout_height: 9000 },
  },
};
const L1_ESPLORA = { cors: true, identityBlock: { height: 967680, hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042" }, utxos: {} };

/** A page of `url` at `viewport`, set before it loads: a change to touch emulation reloads the page. */
async function openAt(browser, url, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.goto(url).catch(() => {});
  return page;
}

/** A wallet screen at phone size. Home has no [data-screen-ready]: every screen's layout marks [data-bar-known]. */
async function openWalletAt(session, route, viewport = PHONE) {
  const page = await openAt(session.browser, session.extensionUrl(`index.html${route}`), viewport);
  await page.waitForSelector("[data-bar-known]", { timeout: 20_000 });
  return page;
}

/** What doesn't fit the screen: sideways scrolling, where the bottom bar and the frame sit, and tiny text. */
function layout(page, smallest) {
  return page.evaluate((smallest) => {
    const box = (e) => {
      const r = e?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom, height: r.height } : null;
    };
    const small = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent.trim();
      const element = node.parentElement;
      if (text === "" || element.getClientRects().length === 0) continue;
      const size = parseFloat(getComputedStyle(element).fontSize);
      if (size < smallest - 0.01) small.push({ text, size });
    }
    return {
      view: document.documentElement.dataset.view ?? null,
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      bar: box(document.querySelector("nav.bottom-bar")),
      frame: box(document.querySelector(".frame")),
      small,
    };
  }, smallest);
}

/**
 * Asserts the page fits `screen` (a phone's by default): no sideways scrolling, the frame its height,
 * the bottom bar on screen, no text smaller than the smallest the wallet draws. Against the screen's
 * width, not innerWidth alone: a phone zooms out to show a page wider than itself, and innerWidth
 * grows with it.
 */
async function assertFits(page, what, screen = PHONE, { bar = true } = {}) {
  const shown = await layout(page, SMALLEST_TEXT_PX);
  const facts = JSON.stringify({ ...shown, small: undefined });
  assert.ok(shown.width <= screen.width && shown.scrollWidth <= shown.width, `${what} doesn't fit ${screen.width}px: ${facts}`);
  assert.equal(shown.frame?.height, screen.height, `${what}'s frame is the screen's height: ${facts}`);
  if (bar) {
    assert.ok(shown.bar, `${what} has its bottom bar`);
    assert.ok(shown.bar.top >= 0 && shown.bar.bottom <= screen.height, `${what}'s bottom bar is on screen: ${facts}`);
  }
  assert.deepEqual(shown.small, [], `${what} has no text under ${SMALLEST_TEXT_PX}px`);
  return shown;
}

describe("brave", { skip: !BROWSERS.includes("brave") }, () => {
  let session;
  let stub;
  let l1Stub;
  let app;
  before(async () => {
    [session, stub, l1Stub, app] = await Promise.all([launchWallet("brave"), serveFlushEsplora(FLUSH), serveL1Esplora(L1_ESPLORA), serveTestApp()]);
    await setUpWallet(session, { on: [99] });
  });
  after(async () => {
    await session?.close();
    await stub?.close();
    await l1Stub?.close();
    await app?.close();
  });

  test("home, History, a chain and Send fit 360px with the bottom bar on screen", async () => {
    const home = await openWalletAt(session, "#/");
    await homeSettled(home);
    await assertFits(home, "home");
    await home.tap('[data-tab="activity"]');
    await activitySettled(home);
    await assertFits(home, "History");
    await home.tap('[data-tab="assets"]');
    await homeSettled(home);
    await home.close();

    const chain = await openWalletAt(session, "#/chain/99");
    await chain.waitForSelector("[data-chain-screen][data-settled]", { timeout: 20_000 });
    await assertFits(chain, "Flush's chain screen");
    await chain.tap('[data-tab="activity"]');
    await activitySettled(chain);
    await assertFits(chain, "Flush's Activity");
    await chain.waitForSelector("[data-chain-screen][data-settled]", { timeout: 20_000 });
    await chain.close();

    const send = await openWalletAt(session, "#/send/99");
    await send.waitForSelector("[data-screen-ready] form", { timeout: 20_000 });
    await assertFits(send, "Send");
    await send.close();
  });

  test("home doesn't scroll sideways at 320px either", async () => {
    const screen = { ...PHONE, width: 320 };
    const home = await openWalletAt(session, "#/", screen);
    await homeSettled(home);
    await assertFits(home, "home at 320px", screen);
    await home.close();
  });

  test("the toolbar popup is still 400×600, with nothing sideways", async () => {
    const popup = await openWalletAt(session, "?view=popup#/", POPUP);
    await homeSettled(popup);
    const shown = await assertFits(popup, "the popup", POPUP);
    assert.equal(shown.view, "popup");
    await popup.close();
  });

  test("a Flush trade's approval at 360px and 320px shows both amounts in full", async () => {
    const page = await openTestApp(session, app, "dex.localhost");
    const asking = page.evaluate(() => window.flush.request({ method: "flush_requestAddress" }));
    const grant = await session.waitForApprovalWindow();
    await grant.click("[data-approve]");
    assert.equal((await asking).address, RECEIVE_0.address);

    const link = `flush:swap?v=1&network=ecashbeta&exp=${Math.floor(Date.now() / 1000) + 600}&pool=${BROSEVELT_POOL}&from=ECX&to=BROSEVELT&amount=0.0001&min_out=${MIN_OUT}`;
    const submitting = page.evaluate(
      (uri) => window.flush.request({ method: "flush_submit", params: { uri } }).catch((e) => ({ code: e.code, message: e.message })),
      link,
    );
    const approval = await Promise.race([
      session.waitForApprovalWindow({ timeout: 20_000 }),
      submitting.then((answer) => assert.fail(`answered before any approval: ${JSON.stringify(answer)}`)),
    ]);
    // At 360px, then at the narrowest phones' 320px. Turning touch emulation on reloads the window,
    // which shows the same request again; the second size keeps it, so only resizes.
    for (const width of [PHONE.width, 320]) {
      await approval.setViewport({ ...PHONE, width });
      await approval.waitForSelector("[data-approval-ready] [data-trade-receive]", { timeout: 20_000 });
      const shown = await approval.evaluate(() => {
        const card = document.querySelector("[data-trade]").getBoundingClientRect();
        // Every line of each amount and its badge, against the card it sits in.
        const outside = [];
        for (const side of ["[data-trade-pay]", "[data-trade-receive]"]) {
          for (const part of document.querySelectorAll(`${side} strong, ${side} strong + *`)) {
            for (const r of part.getClientRects()) {
              if (r.left < card.left - 0.5 || r.right > card.right + 0.5) outside.push({ side, text: part.textContent, left: r.left, right: r.right });
            }
          }
        }
        const text = (q) => document.querySelector(q).textContent.replace(/\s+/g, " ").trim();
        return {
          pay: text("[data-trade-pay]"),
          receive: text("[data-trade-receive]"),
          card: { left: card.left, right: card.right },
          outside,
          scrollWidth: document.documentElement.scrollWidth,
          width: innerWidth,
        };
      });
      assert.equal(shown.pay, "Pay 0.00010000 ECX");
      assert.equal(shown.receive, "Receive at least 999,999,999,999,999.00 BROSEVELT");
      assert.deepEqual(shown.outside, [], `at ${width}px, amounts cut off at the card's edge (${shown.card.left}–${shown.card.right})`);
      assert.ok(shown.width <= width && shown.scrollWidth <= shown.width, `the approval doesn't fit ${width}px: ${shown.scrollWidth}px in ${shown.width}px`);
    }

    await approval.click("[data-reject]");
    assert.equal((await submitting).code, 4001);
    await page.close();
  });

  describe("the web build", () => {
    let web;
    let webSession;
    before(async () => {
      [web, webSession] = await Promise.all([serveWebWallet(), launchWebWallet("brave")]);
    });
    after(async () => {
      await webSession?.close();
      await web?.close();
    });

    test("the Apps view fits 360px with the bottom bar on screen", async () => {
      const page = await openAt(webSession.browser, `${web.url}#/import`, PHONE);
      await page.waitForSelector("[data-wallet-ready]", { timeout: 20_000 });
      await page.type("[data-import-phrase]", ABANDON);
      await page.type("[data-new-password]", WALLET_PASSWORD);
      await page.type("[data-repeat-password]", WALLET_PASSWORD);
      await page.tap("[data-submit]");
      await page.waitForSelector('[data-vault-state="unlocked"]', { timeout: 20_000 });
      await homeSettled(page);
      await assertFits(page, "the web build's home");
      // As the bar's link does: a reload would end the Worker, and with it the unlocked session.
      await page.tap("[data-apps-link]");
      await waitForFunction(page, () => location.hash === "#/apps" && document.querySelector("[data-apps]") !== null);
      await assertFits(page, "the Apps view");
      await page.close();
    });
  });
});
