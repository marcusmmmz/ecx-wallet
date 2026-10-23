// Seam 1: a Sidechain App sends an explicit Elements transfer the Decoder fully understands; it is
// shown as a Clear View and signed without the Blind Signing opt-in.
//
// Fixtures come from core/elements/tests/fixtures.rs. `clear` spends one input of the "abandon …
// about" wallet's Slot 24 account and one foreign input, pays a foreign address 120 000, sends
// 29 000 change back to us, with a 1 000 fee. `dangerous` is the same plus a withdrawal burn
// (output 3), with our input signing SINGLE|ANYONECANPAY. `signed` is each PSET signed by LWK's own
// SwSigner.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { BROWSERS, ROOT, launchWallet, openTestApp, serveTestApp, setUpWallet } from "../harness.mjs";

const PSETS = JSON.parse(await readFile(path.join(ROOT, "e2e", "fixtures", "elements-psets.json"), "utf8"));
const CHAIN = "ecash:betanet-s24";
// Re-derived from the fixture keys (core/elements/tests/clear_view.rs).
const FOREIGN_ADDRESS = "elements1qepkhlwlq2qjggg89d5quqx8z59vz9mr2h6j4pc";
const CHANGE_ADDRESS = "elements1q2n6usykz5ycrnfpup3hx0qa0manae07jgvvmuc";

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

/** The Clear View as a user reads it: rows in page order. */
function readClearView(approval) {
  return approval.evaluate(() => {
    const text = (e) => e?.textContent.replace(/\s+/g, " ").trim();
    const all = [...document.querySelectorAll("[data-dangerous-mode], [data-output], [data-fee]")];
    return {
      clearView: document.querySelector("[data-clear-view]") !== null,
      blind: document.querySelector("[data-blind]") !== null,
      origin: text(document.querySelector("[data-origin]")),
      chain: text(document.querySelector("[data-chain]")),
      order: all.map((e) => (e.hasAttribute("data-dangerous-mode") ? "dangerous" : e.hasAttribute("data-output") ? "output" : "fee")),
      dangerous: [...document.querySelectorAll("[data-dangerous-mode]")].map(text),
      outputs: [...document.querySelectorAll("[data-output]")].map((e) => ({
        text: text(e),
        address: text(e.querySelector("[data-destination]")),
        yours: e.querySelector("[data-yours]") !== null,
        label: text(e.querySelector("[data-hint-label]")),
      })),
      fee: text(document.querySelector("[data-fee]")),
      summary: text(document.querySelector("[data-hint-summary]")),
      issuance: text(document.querySelector("[data-issuance]")),
      contract: text(document.querySelector("[data-contract]")),
      issuerYours: document.querySelector("[data-issuer-yours]") !== null,
    };
  });
}

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  let app;
  let page;
  before(async () => {
    [session, app] = await Promise.all([launchWallet(browserName), serveTestApp()]);
    await setUpWallet(session);
    // A Grant without the Blind Signing opt-in.
    page = await openTestApp(session, app, "shop.localhost");
    const connecting = page.evaluate(() => window.testApp.request("connect", { slots: [24], methods: ["signTransaction"] }));
    await (await session.waitForApprovalWindow()).click("[data-approve]");
    assert.ok((await connecting).result, "connected");
  });
  after(async () => {
    await session?.close();
    await app?.close();
  });

  test("a plain explicit transfer is shown as a Clear View and signed without the Blind opt-in", async () => {
    const hints = { summary: "Pay Bob for the bike", outputLabels: { 0: "change", 1: "Bob" } };
    const signing = signTransaction(page, signingRequest(PSETS.clear.payload, { hints }));
    const approval = await session.waitForApprovalWindow();
    const shown = await readClearView(approval);

    assert.equal(shown.clearView, true);
    assert.equal(shown.blind, false);
    assert.equal(shown.origin, app.origin("shop.localhost"));
    assert.equal(shown.chain, CHAIN);
    assert.deepEqual(shown.dangerous, []);
    assert.equal(shown.outputs.length, 2);
    const [pay, change] = shown.outputs;
    assert.equal(pay.address, FOREIGN_ADDRESS);
    assert.match(pay.text, /^0\.0012 ECX\b/, "the policy asset is its Chain Entry's ECX");
    assert.equal(pay.yours, false, "the requester calling it change doesn't make it ours");
    assert.equal(pay.label, `Reported by ${app.origin("shop.localhost")}: change`);
    assert.equal(change.address, CHANGE_ADDRESS);
    assert.match(change.text, /^0\.00029 ECX\b/);
    assert.equal(change.yours, true, "re-derived to this wallet");
    assert.equal(shown.fee, "0.00001 ECX");
    assert.equal(shown.summary, `Reported by ${app.origin("shop.localhost")}: Pay Bob for the bike`);

    await approval.click("[data-approve]");
    assert.deepEqual(await signing, { result: PSETS.clear.signed });
  });

  test("a new issuance is a Clear View, signed without the Blind opt-in, naming the asset and token the wallet derives", async () => {
    const signing = signTransaction(page, signingRequest(PSETS.issuance.payload));
    const approval = await session.waitForApprovalWindow();
    const shown = await readClearView(approval);

    assert.equal(shown.clearView, true);
    assert.deepEqual(shown.dangerous, [], "issuing costs only the fee");
    assert.match(shown.issuance, /^Creates a new asset 1,000,000 base units of new asset \S+ 1 base units of its reissuance token \S+\. .*can't issue more.* Contract hash [0-9a-f]{64} /);
    const [asset, token, change] = shown.outputs;
    assert.match(asset.text, /^1,000,000 New asset /);
    assert.match(token.text, /^1 Reissuance token /);
    assert.match(change.text, /^0\.00099 ECX\b/);
    assert.ok(asset.yours && token.yours && change.yours, "all back to the address getAddresses gave out");

    await approval.click("[data-approve]");
    assert.deepEqual(await signing, { result: PSETS.issuance.signed });
  });

  test("an issuance with its contract as evidence is shown in the contract's units, with the issuer key checked", async () => {
    const { payload, signed, contract } = PSETS.issuanceWithContract;
    const signing = signTransaction(page, signingRequest(payload, { evidence: { assetContract: { 0: contract } } }));
    const approval = await session.waitForApprovalWindow();
    const shown = await readClearView(approval);

    assert.equal(shown.clearView, true);
    assert.match(shown.issuance, /^Creates a new asset 0\.01000000 EXA \(Example Asset\), new asset /, "every decimal place the contract gives");
    assert.match(shown.contract, /Example Asset \(EXA\), 8 decimal places\. .*Claims the domain dex\.example \(not checked by this wallet\)/);
    assert.equal(shown.issuerYours, true, "the issuer key is the getAddresses address's");
    assert.match(shown.outputs[0].text, /^0\.01 EXA New asset /);

    await approval.click("[data-approve]");
    assert.deepEqual(await signing, { result: signed });
  });

  test("an issuance whose contract evidence doesn't match its committed hash is refused with -32602", async () => {
    const { payload, contract } = PSETS.issuanceWithContract;
    const other = contract.replace('"EXA"', '"EXB"');
    const answer = await signTransaction(page, signingRequest(payload, { evidence: { assetContract: { 0: other } } }));
    assert.equal(answer.error?.code, -32602, answer.error?.message);
    assert.match(answer.error?.message, /isn't the one its issuance commits to/);
    assert.equal((await session.approvalWindows()).length, 0);
  });

  test("dangerous modes come above everything else; a withdrawal is described as irreversible and slow", async () => {
    const signing = signTransaction(page, signingRequest(PSETS.dangerous.payload));
    const approval = await session.waitForApprovalWindow();
    const shown = await readClearView(approval);
    assert.equal(shown.clearView, true);
    assert.equal(shown.dangerous.length, 2);
    assert.deepEqual(shown.order.slice(0, 2), ["dangerous", "dangerous"]);
    assert.match(shown.dangerous.join("\n"), /sighash/i);
    const withdrawal = shown.dangerous.find((d) => /withdrawal/i.test(d));
    assert.match(withdrawal, /irreversible/i);
    assert.match(withdrawal, /months/i);
    // The burn's row names its L1 destination as an L1 address, not as raw script hex.
    const burn = shown.outputs.find((o) => /withdrawal/i.test(o.text));
    assert.equal(burn.address, "bc1qzyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3h8ffkz");

    await approval.click("[data-approve]");
    assert.deepEqual(await signing, { result: PSETS.dangerous.signed });
  });

  test("hints never make a Blind request Clear", async () => {
    const hints = { summary: "A perfectly normal transfer", outputLabels: { 0: "change" } };
    const answer = await signTransaction(page, signingRequest(PSETS.blind.payload, { hints }));
    assert.equal(answer.error?.code, 4100);
    assert.match(answer.error?.message, /Blind/);
    assert.equal((await session.approvalWindows()).length, 0);
  });

  test("none of the above raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
