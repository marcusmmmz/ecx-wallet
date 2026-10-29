// A site's approvals show in the wallet's side panel when it's open in the site's browser window,
// not in a window of their own. Brave only: Firefox's sidebar can't be opened from a test.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openTestApp, openWalletPage, serveTestApp, setUpWallet } from "../harness.mjs";

const CONNECT = { slots: [24], methods: ["getAddresses"] };

describe("brave", { skip: !BROWSERS.includes("brave") }, () => {
  let session;
  let app;
  let wallet;
  let panel;

  /** Opens the side panel in `wallet`'s window (it needs a click) and returns its page. */
  async function openPanel() {
    await wallet.evaluate(() => {
      const button = document.createElement("button");
      button.id = "open-panel";
      button.style.cssText = "position:fixed;top:0;left:0;z-index:99999;width:80px;height:40px";
      button.onclick = () => chrome.windows.getCurrent().then((w) => chrome.sidePanel.open({ windowId: w.id }));
      document.body.append(button);
    });
    await wallet.click("#open-panel");
    const target = await session.browser.waitForTarget((t) => t.url().includes("index.html?view=panel"), { timeout: 10_000 });
    const page = await target.asPage();
    await page.waitForSelector("[data-bar-known]", { timeout: 10_000 });
    return page;
  }

  const connect = (page) => page.evaluate((scope) => window.testApp.request("connect", scope), CONNECT);

  before(async () => {
    [session, app] = await Promise.all([launchWallet("brave"), serveTestApp()]);
    await setUpWallet(session);
    wallet = await openWalletPage(session, "#/settings");
    panel = await openPanel();
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  // A new tab opens in the wallet's window, as the panel's; `chrome.windows.create` opens another.
  test("a site in the panel's window is approved in the panel, its origin shown, and no window opens", async () => {
    const site = await openTestApp(session, app, "dex.localhost");
    const connecting = connect(site);
    // It takes no click until it has been in view a moment: one meant for the screen can't land on it.
    await panel.waitForSelector("[data-panel-approval] [data-approval-ready]", { timeout: 10_000 });
    assert.equal(await panel.$eval("[data-panel-approval]", (e) => e.inert), true, "not armed at first");
    await panel.waitForSelector("[data-panel-approval][data-armed] [data-approval-ready]", { timeout: 10_000 });
    assert.equal(await panel.$eval("[data-panel-approval] [data-origin]", (e) => e.textContent.trim()), app.origin("dex.localhost"));
    assert.equal((await session.approvalWindows()).length, 0, "no approval window");
    await panel.click("[data-panel-approval] [data-approve]");
    assert.deepEqual((await connecting).result?.slots, [24]);
    await panel.waitForFunction(() => document.querySelector("[data-panel-approval]") === null, { timeout: 10_000 });
    await site.close();
  });

  test("a site in another window gets a window of its own: the panel never sees its approval", async () => {
    await wallet.evaluate((url) => chrome.windows.create({ url }), app.url("other.localhost"));
    const target = await session.browser.waitForTarget((t) => t.url().startsWith(app.url("other.localhost")), { timeout: 10_000 });
    const site = await target.asPage();
    await site.waitForFunction(() => window.testApp !== undefined);
    const connecting = connect(site);
    const approval = await session.waitForApprovalWindow();
    assert.equal(await panel.$("[data-panel-approval]"), null, "nothing in the panel");
    await approval.click("[data-reject]");
    assert.equal((await connecting).error?.code, 4001);
    await site.close();
  });

  test("closing the panel mid-approval rejects it, as closing its window would", async () => {
    const site = await openTestApp(session, app, "third.localhost");
    const connecting = connect(site);
    await panel.waitForSelector("[data-panel-approval][data-armed] [data-approval-ready]", { timeout: 10_000 });
    await panel.close();
    assert.equal((await connecting).error?.code, 4001);
    assert.equal((await session.approvalWindows()).length, 0);
    await site.close();
  });

  test("with the panel closed, a site's approval opens a window again: a wallet tab posing as the panel gets none", async () => {
    // The panel's view in a tab: the background takes a window's approvals only from the panel itself.
    const posing = await session.openPage("index.html?view=panel#/settings");
    await posing.waitForSelector("[data-bar-known]", { timeout: 10_000 });
    const site = await openTestApp(session, app, "fourth.localhost");
    const connecting = connect(site);
    const approval = await session.waitForApprovalWindow();
    assert.equal(await posing.$("[data-panel-approval]"), null, "nothing in the tab");
    await posing.close();
    await approval.click("[data-reject]");
    assert.equal((await connecting).error?.code, 4001);
    await site.close();
  });
});
