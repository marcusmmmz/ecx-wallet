// Seam 1: a Sidechain App sends signTransaction and gets a Blind signature, or the right refusal.
//
// The fixture PSETs come from core/elements/tests/fixtures.rs. `blind.payload` spends one input of
// the "abandon … about" wallet's Slot 24 account and one foreign input, and carries fields the
// Decoder doesn't know, so it is Blind. `blind.signed` is that PSET signed by LWK's own SwSigner
// with the same Starter: getting exactly it back means a valid signature on our input only, every
// other byte unchanged.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { BROWSERS, ROOT, WALLET_PASSWORD, launchWallet, openTestApp, serveTestApp, setUpWallet } from "../harness.mjs";

const PSETS = JSON.parse(await readFile(path.join(ROOT, "e2e", "fixtures", "elements-psets.json"), "utf8"));
const CHAIN = "ecash:betanet-s24";

/** A Signing Request envelope for `payload`, valid for ten minutes unless overridden. */
function signingRequest(payload, overrides = {}) {
  return {
    version: "1.0",
    id: `req-${Math.random().toString(36).slice(2)}`,
    chain: CHAIN,
    method: "signTransaction",
    format: "pset",
    payload,
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  };
}

const signTransaction = (page, request) => page.evaluate((r) => window.testApp.request("signTransaction", r), request);

/** What the approval window shows for a signing request, read the way a user would see it. */
function readSigningApproval(approval) {
  return approval.evaluate(() => {
    const texts = (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim());
    return {
      blind: document.querySelector("[data-blind]") !== null,
      clearView: document.querySelector("[data-clear-view]") !== null,
      origin: document.querySelector("[data-origin]")?.textContent.trim(),
      chain: document.querySelector("[data-chain]")?.textContent.trim(),
      ownedInputs: texts("[data-owned-input]"),
      totalLeaving: texts("[data-total-leaving]"),
      fee: texts("[data-fee]"),
      unknownFields: texts("[data-unknown-field]"),
    };
  });
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

  /** `answering`'s answer; fails (closing it) if an approval window opens first. */
  async function answeredWithoutWindow(answering) {
    const window = session.waitForApprovalWindow({ timeout: 3_000 }).then(
      async (approval) => {
        await approval.close();
        return "an approval window opened";
      },
      () => "no window",
    );
    const answer = await Promise.race([answering, window]);
    assert.notEqual(answer, "an approval window opened", "no approval window");
    await window;
    return answer;
  }

  /** Connects `host` for Slot 24 signTransaction; ticks the Blind Signing opt-in if `blind`. */
  async function connect(host, { blind }) {
    const page = await openTestApp(session, app, host);
    const connecting = page.evaluate(() => window.testApp.request("connect", { slots: [24], methods: ["signTransaction"] }));
    const approval = await session.waitForApprovalWindow();
    assert.equal(await approval.$eval("[data-blind-opt-in]", (e) => e.checked), false, "Blind Signing is off by default");
    if (blind) await approval.click("[data-blind-opt-in]");
    await approval.click("[data-approve]");
    assert.ok((await connecting).result, "connected");
    return page;
  }

  let blindApp;
  test("with the Blind opt-in, the window shows the request loudly as Blind with its verifiable facts, and approving returns the PSET signed on our input only", async () => {
    blindApp = await connect("blind.localhost", { blind: true });
    const signing = signTransaction(blindApp, signingRequest(PSETS.blind.payload));
    const approval = await session.waitForApprovalWindow();
    const shown = await readSigningApproval(approval);
    assert.equal(shown.blind, true);
    assert.equal(shown.clearView, false, "a Blind request never looks like a Clear View");
    assert.equal(shown.origin, app.origin("blind.localhost"));
    assert.equal(shown.chain, CHAIN);
    assert.equal(shown.ownedInputs.length, 1);
    assert.match(shown.ownedInputs[0], /: 0\.001 ECX$/);
    assert.match(shown.totalLeaving.join(" "), /^0\.00071 ECX$/);
    assert.match(shown.fee.join(" "), /^0\.00001 ECX$/);
    assert.equal(shown.unknownFields.length, 4);

    await approval.click("[data-approve]");
    assert.deepEqual(await signing, { result: PSETS.blind.signed });
  });

  test("rejecting in the window returns 4001", async () => {
    const signing = signTransaction(blindApp, signingRequest(PSETS.blind.payload));
    await (await session.waitForApprovalWindow()).click("[data-reject]");
    assert.equal((await signing).error?.code, 4001);
  });

  test("without the Blind opt-in, a Blind request is refused and no window opens", async () => {
    const page = await connect("no-blind.localhost", { blind: false });
    const answer = await signTransaction(page, signingRequest(PSETS.blind.payload));
    assert.equal(answer.error?.code, 4100);
    assert.match(answer.error?.message, /Blind/);
    assert.equal((await session.approvalWindows()).length, 0);
    await page.close();
  });

  test("a site can't ask for Blind Signing through connect: only the approval window's checkbox turns it on", async () => {
    const page = await connect("asks-blind.localhost", { blind: false });
    const asking = page.evaluate(() =>
      window.testApp.request("connect", { slots: [24], methods: ["signTransaction"], blindSigning: true }),
    );
    const answer = await answeredWithoutWindow(asking);
    assert.deepEqual(answer.result, { slots: [24], methods: ["signTransaction"] }, "the Grant, without Blind Signing");
    await page.close();
  });

  const refusals = [
    ["an unknown envelope MAJOR version", () => signingRequest(PSETS.blind.payload, { version: "2.0" }), 4200, /version/i],
    ["an expired request", () => signingRequest(PSETS.blind.payload, { expiresAt: Math.floor(Date.now() / 1000) - 1 }), -32602, /expired/i],
    ["a Slot outside the Grant", () => signingRequest(PSETS.blind.payload, { chain: "ecash:betanet-s9" }), 4100, /Slot 9/],
    ["a PSET for another chain (ELIP-101 genesis)", () => signingRequest(PSETS.wrongGenesis.payload), -32602, /genesis/i],
    ["a confidential input", () => signingRequest(PSETS.confidentialInput.payload), -32602, /confidential/i],
    ["a confidential output", () => signingRequest(PSETS.confidentialOutput.payload), -32602, /confidential/i],
    ["an input missing bip32_derivation", () => signingRequest(PSETS.missingDerivation.payload), -32602, /bip32_derivation/],
  ];
  for (const [what, request, code, message] of refusals) {
    test(`${what} is refused with ${code}, without a window`, async () => {
      const answer = await signTransaction(blindApp, request());
      assert.equal(answer.error?.code, code, answer.error?.message);
      assert.match(answer.error?.message, message);
      assert.equal((await session.approvalWindows()).length, 0);
    });
  }

  test("unknown envelope fields are ignored", async () => {
    const signing = signTransaction(blindApp, signingRequest(PSETS.blind.payload, { futureField: { x: 1 } }));
    await (await session.waitForApprovalWindow()).click("[data-approve]");
    assert.deepEqual(await signing, { result: PSETS.blind.signed });
  });

  test("a request while locked shows unlock first, then the approval", async () => {
    const home = await session.openPage("index.html#/");
    await home.waitForSelector('[data-vault-state="unlocked"]', { timeout: 10_000 });
    await home.click("[data-lock]");
    await home.waitForSelector('[data-vault-state="locked"]');
    await home.close();

    const signing = signTransaction(blindApp, signingRequest(PSETS.blind.payload));
    const approval = await session.waitForApprovalWindow();
    await approval.waitForSelector("[data-unlock-required]");
    assert.equal(await approval.$("[data-approve]"), null, "nothing to approve before unlocking");
    await approval.type("[data-password]", WALLET_PASSWORD);
    await approval.click("[data-unlock]");
    await approval.waitForSelector("[data-blind]", { timeout: 20_000 });
    await approval.click("[data-approve]");
    assert.deepEqual(await signing, { result: PSETS.blind.signed });
  });

  test("while locked, a request the Chain Module refuses without the Starter is refused without an unlock window", async () => {
    const home = await session.openPage("index.html#/");
    await home.waitForSelector('[data-vault-state="unlocked"]', { timeout: 10_000 });
    await home.click("[data-lock]");
    await home.waitForSelector('[data-vault-state="locked"]');
    await home.close();

    const starterFree = [
      [PSETS.wrongGenesis.payload, /genesis/i],
      [PSETS.confidentialInput.payload, /confidential/i],
      [PSETS.confidentialOutput.payload, /confidential/i],
      // Not a missing bip32_derivation: only the Starter can tell it from the address it gave out.
    ];
    for (const [payload, message] of starterFree) {
      const answer = await answeredWithoutWindow(signTransaction(blindApp, signingRequest(payload)));
      assert.equal(answer.error?.code, -32602, answer.error?.message);
      assert.match(answer.error?.message, message);
    }
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
