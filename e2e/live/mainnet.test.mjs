// Live, opt-in (`pnpm test:mainnet-live`): the shipped build against the public mainnet explorers
// its Chain Entries name, eCash's (explorer.ecash.ninja) and Flush's (explorer.blockfab.org). It
// only reads: it imports "abandon … about", and checks each server is on the chain the wallet pins
// and that home and Activity load from it. Nothing is signed or broadcast.
//
// Not in `pnpm test`: it needs the network, and what the servers hold changes. The stub-backed
// mainnet build covers sending, Deposits and apps (tests/mainnet.test.mjs).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { activitySettled, BROWSERS, DIST, homeSettled, importWallet, launchWallet, openWalletPage, setUpWallet } from "../harness.mjs";

const SLOT = 46;
const wallet = await importWallet();
const [l1, flush] = await Promise.all([
  readFile(path.join(DIST.chromium, "l1.wasm")).then(wallet.loadL1Module),
  readFile(path.join(DIST.chromium, "flush.wasm")).then(wallet.loadChainModule),
]);
const L1_ENTRY = l1.chainEntry().networks.mainnet;
const FLUSH_ENTRY = flush.chainEntry().networks.mainnet;

/** A server's answer to an Esplora path, as text. */
async function read(server, pathname) {
  const response = await fetch(`${server.url}${pathname}`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(response.status, 200, `${server.url}${pathname}`);
  return (await response.text()).trim();
}

test("the shipped build serves mainnet, with Flush as Slot 46", () => {
  assert.equal(l1.declare().binding.chain, "ecash:mainnet");
  assert.equal(flush.declare().binding.chain, `ecash:mainnet-s${SLOT}`);
});

test("eCash's mainnet server has the fork block the wallet pins, and Slot 46's activation", async () => {
  const server = L1_ENTRY.sidechainServer;
  assert.equal(await read(server, `/block-height/${L1_ENTRY.identityBlock.height}`), L1_ENTRY.identityBlock.hash);
  assert.equal(await read(server, `/block-height/${FLUSH_ENTRY.activation.height}`), FLUSH_ENTRY.activation.hash);
  assert.ok(Number(await read(server, "/blocks/tip/height")) > FLUSH_ENTRY.activation.height);
});

test("Flush's mainnet server has the genesis block the wallet pins, and a tip", async () => {
  const server = FLUSH_ENTRY.sidechainServer;
  assert.equal(await read(server, `/block-height/${FLUSH_ENTRY.identityBlock.height}`), FLUSH_ENTRY.identityBlock.hash);
  assert.ok(Number(await read(server, "/blocks/tip/height")) > 0);
});

for (const browserName of BROWSERS) describe(browserName, () => {
  let session;
  before(async () => {
    session = await launchWallet(browserName, { build: "shipped" });
    await setUpWallet(session, { on: [SLOT] }); // ABANDON, no passphrase
  });
  after(async () => {
    await session?.close();
  });

  test("home reads both chains from their mainnet servers, with no error", async () => {
    const page = await session.openPage("index.html#/");
    await homeSettled(page);
    const shown = await page.evaluate(() =>
      [...document.querySelectorAll("[data-account]")].map((card) => ({
        account: card.getAttribute("data-account"),
        error: card.querySelector("[data-balance-error]")?.textContent.replace(/\s+/g, " ").trim() ?? null,
      })),
    );
    assert.deepEqual(shown, [{ account: "l1", error: null }, { account: String(SLOT), error: null }]);
    await page.close();
  });

  for (const chain of ["l1", String(SLOT)]) {
    test(`${chain === "l1" ? "eCash" : "Flush"}'s Activity loads from its server`, async () => {
      const page = await openWalletPage(session, `#/chain/${chain}/activity`);
      await activitySettled(page);
      assert.equal(await page.$("[data-history-error]"), null, await page.$eval("[data-history-error]", (e) => e.textContent).catch(() => ""));
      await page.close();
    });
  }

  test("nothing raised extension runtime errors", async () => {
    assert.deepEqual((await session.extensionErrors()).runtimeErrors, []);
  });
});
