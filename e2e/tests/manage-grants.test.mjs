// Seam 1: a user sees and revokes Grants; a Sidechain App disconnects.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BROWSERS, launchWallet, openTestApp, openWalletPage, serveTestApp, setUpWallet, waitForFunction } from "../harness.mjs";

for (const browserName of BROWSERS) describe(browserName, () => {

let session;
let app;
before(async () => {
  [session, app] = await Promise.all([launchWallet(browserName), serveTestApp()]);
  // Unlocked, so a Granted getAddresses actually answers.
  await setUpWallet(session);
});
after(async () => {
  await session?.close();
  await app?.close();
});

/** Opens the test app on `host` and connects it with `scope`, approving the prompt. */
async function connected(host, scope) {
  const page = await openTestApp(session, app, host);
  const connecting = page.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  assert.ok((await connecting).result, "connect was approved");
  return page;
}

const getAddresses = (page) => page.evaluate(() => window.testApp.request("getAddresses", { slot: 24 }));

test("disconnect removes the calling origin's Grant only", async () => {
  const scope = { slots: [24], methods: ["getAddresses"] };
  const leaving = await connected("leaving.localhost", scope);
  const staying = await connected("staying.localhost", scope);

  assert.deepEqual(await leaving.evaluate(() => window.testApp.request("disconnect")), { result: null });
  assert.equal((await getAddresses(leaving)).error?.code, 4100);
  assert.ok((await getAddresses(staying)).result, "the other origin still gets its addresses");

  // Disconnecting again, with no Grant left, is harmless.
  assert.deepEqual(await leaving.evaluate(() => window.testApp.request("disconnect")), { result: null });
  await Promise.all([leaving.close(), staying.close()]);
});

/** The Grants screen as a user reads it: one entry per origin. */
async function readGrants() {
  const page = await openWalletPage(session, "#/grants");
  const grants = await page.evaluate(() =>
    [...document.querySelectorAll("[data-grant]")].map((g) => ({
      origin: g.querySelector("[data-origin]")?.textContent.trim(),
      slots: [...g.querySelectorAll("[data-slot]")].map((e) => e.textContent.trim()),
      methods: [...g.querySelectorAll("[data-method]")].map((e) => e.textContent.trim()),
      blindSigning: g.querySelector("[data-blind-signing]")?.textContent.trim(),
    })),
  );
  return { page, grants };
}

test("the Grants screen lists every Grant by origin with its scope and Blind Signing opt-in", async () => {
  const listedA = await connected("listed-a.localhost", { slots: [24], methods: ["getAddresses"] });
  const listedB = await connected("listed-b.localhost", { slots: [24], methods: ["getAddresses", "signTransaction"] });

  const { page, grants } = await readGrants();
  const listed = grants.filter((g) => g.origin.includes("listed-"));
  assert.deepEqual(listed, [
    { origin: app.origin("listed-a.localhost"), slots: ["24"], methods: ["getAddresses"], blindSigning: "Off" },
    { origin: app.origin("listed-b.localhost"), slots: ["24"], methods: ["getAddresses", "signTransaction"], blindSigning: "Off" },
  ]);
  await Promise.all([page.close(), listedA.close(), listedB.close()]);
});

test("revoking a Grant on the Grants screen makes that origin's next request fail with 4100 until it connects again", async () => {
  const scope = { slots: [24], methods: ["getAddresses"] };
  const revoked = await connected("revoked.localhost", scope);
  const kept = await connected("kept.localhost", scope);
  const revokedOrigin = app.origin("revoked.localhost");

  const { page } = await readGrants();
  await page.click(`[data-grant][data-grant-origin="${revokedOrigin}"] [data-revoke]`);
  await waitForFunction(
    page,
    (origin) => !document.querySelector(`[data-grant][data-grant-origin="${origin}"]`),
    {},
    revokedOrigin,
  );
  const origins = (await readGrants().then(async ({ page, grants }) => (await page.close(), grants))).map((g) => g.origin);
  assert.ok(!origins.includes(revokedOrigin), "the revoked Grant is gone from the list");
  assert.ok(origins.includes(app.origin("kept.localhost")), "other Grants are untouched");

  assert.equal((await getAddresses(revoked)).error?.code, 4100);
  assert.ok((await getAddresses(kept)).result, "the kept origin still gets its addresses");

  // Connecting again prompts again, and restores access.
  const reconnecting = revoked.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  assert.deepEqual(await reconnecting, { result: scope });
  assert.ok((await getAddresses(revoked)).result, "reconnecting restores access");
  await Promise.all([page.close(), revoked.close(), kept.close()]);
});

test("grantChanged tells an origin's open pages when its Grant is widened, revoked or disconnected, and no other origin", async () => {
  const scope = { slots: [24], methods: ["getAddresses"] };
  const tabA = await connected("events.localhost", scope);
  const tabB = await openTestApp(session, app, "events.localhost"); // the same origin, another tab
  const other = await connected("events-other.localhost", scope);
  for (const page of [tabA, tabB, other]) await page.evaluate(() => window.testApp.listen("grantChanged"));
  const events = (page) => page.evaluate(() => window.testApp.events);
  const until = (page, count) => waitForFunction(page, (n) => window.testApp.events.length >= n, { timeout: 10_000 }, count);

  // Widened by connect: both tabs of the origin hear it.
  const widened = { slots: [24], methods: ["getAddresses", "signTransaction"] };
  const widening = tabA.evaluate((scope) => window.testApp.request("connect", scope), widened);
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  await widening;
  await Promise.all([until(tabA, 1), until(tabB, 1)]);
  assert.deepEqual(await events(tabB), [["grantChanged", widened]]);

  // Revoked on the Grants screen.
  const origin = app.origin("events.localhost");
  const { page } = await readGrants();
  await page.click(`[data-grant][data-grant-origin="${origin}"] [data-revoke]`);
  await Promise.all([until(tabA, 2), until(tabB, 2)]);
  assert.deepEqual((await events(tabA)).at(-1), ["grantChanged", null]);
  await page.close();

  // Disconnect, by the other origin itself: only its own page hears it.
  await other.evaluate(() => window.testApp.request("disconnect"));
  await until(other, 1);
  assert.deepEqual(await events(other), [["grantChanged", null]]);
  // Disconnecting again changes nothing, so it tells nobody.
  await other.evaluate(() => window.testApp.request("disconnect"));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await events(other)).length, 1);
  assert.equal((await events(tabA)).length, 2, "nothing about another origin's Grant");
  await Promise.all([tabA.close(), tabB.close(), other.close()]);
});

test("getGrant answers the caller's own Grant, and whether the wallet is unlocked, with no window", async () => {
  const page = await openTestApp(session, app, "get-grant.localhost");
  assert.deepEqual(await page.evaluate(() => window.testApp.request("getGrant")), { result: null });
  assert.equal((await session.approvalWindows()).length, 0, "no window, even with no Grant");
  const scope = { slots: [24], methods: ["getAddresses"] };
  const connecting = page.evaluate((scope) => window.testApp.request("connect", scope), scope);
  await (await session.waitForApprovalWindow()).click("[data-approve]");
  await connecting;
  assert.deepEqual(await page.evaluate(() => window.testApp.request("getGrant")), { result: { ...scope, unlocked: true } });
  await page.close();
});

// Brave only: Firefox has no API to read an extension's error console.
test("none of the above raised extension runtime errors", async () => {
  assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
});

});
