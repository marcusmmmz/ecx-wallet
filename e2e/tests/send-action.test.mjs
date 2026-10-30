// `sendAction` and `window.flush` at the Provider (docs/adr/0016), no browser needed: an app hands
// over a `flush:` link and the wallet's trade does the rest. The trade itself is tested in
// flush.test; here, what the Provider adds: `sendTransfer`'s Grant, the app's origin, and the two
// methods flush.markets calls, with the answers it reads.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { DIST_E2E, importWallet } from "../harness.mjs";

const wallet = await importWallet();
const flush = await wallet.loadChainModule(await readFile(path.join(DIST_E2E.chromium, "flush.wasm")));

const ORIGIN = "https://flush.markets";
const LINK = "flush:buy?v=1&network=ecashbeta&exp=1800000600&launch=FORK&asset=6bb2…&ecx=0.0001&min_tokens=0.044";
const ADDRESS = "bflx1qexample";

/** A Provider handler over fakes: Flush (Slot 99) supported and on; `sendAction` answers with `result`. */
function provider({ grant, connect = true, result = { server: "https://explorer.example", accepted: true, txid: "ab".repeat(32) }, trade } = {}) {
  const sent = [];
  const asked = [];
  let stored = grant;
  const handle = wallet.createProviderHandler({
    grants: {
      get: async (o) => (stored?.origin === o ? stored : undefined),
      put: async (g) => void (stored = g),
      remove: async () => {},
      list: async () => (stored ? [stored] : []),
    },
    supportedSlots: [99],
    chainModule: (slot) => (slot === 99 ? Promise.resolve(flush) : undefined),
    isUnlocked: async () => true,
    now: () => Date.now(),
    chains: { isOn: async () => true, turnOn: async () => {} },
    askToConnect: async (prompt) => {
      asked.push(prompt);
      return { approved: connect, blindSigning: false };
    },
    askToTurnOn: async () => assert.fail("asked to turn a chain on"),
    receiveAddresses: async () => [{ chain: "ecash:betanet-s99", address: ADDRESS, publicKey: "02".padEnd(66, "0") }],
    send: async () => assert.fail("a Send"),
    sendAction:
      trade ??
      (async (slot, action, from) => {
        sent.push({ slot, action, from });
        return result;
      }),
  });
  return { handle, sent, asked };
}

const granted = (methods, slots = [99]) => ({ origin: ORIGIN, slots, methods, blindSigning: false });

describe("sendAction", () => {
  test("hands the link to the wallet's trade, naming the app, and answers the txid", async () => {
    const { handle, sent } = provider({ grant: granted(["sendTransfer"]) });
    assert.deepEqual(await handle(ORIGIN, "sendAction", { slot: 99, action: LINK }), { txid: "ab".repeat(32) });
    assert.deepEqual(sent, [{ slot: 99, action: LINK, from: { origin: ORIGIN } }]);
  });

  test("needs sendTransfer's Grant", async () => {
    const { handle, sent } = provider({ grant: granted(["getAddresses", "signTransaction"]) });
    await assert.rejects(handle(ORIGIN, "sendAction", { slot: 99, action: LINK }), (e) => e.code === 4100 && /no Grant for sendTransfer/.test(e.message));
    assert.deepEqual(sent, []);
  });

  test("an action is text", async () => {
    const { handle, sent } = provider({ grant: granted(["sendTransfer"]) });
    await assert.rejects(handle(ORIGIN, "sendAction", { slot: 99, action: { uri: LINK } }), (e) => e.code === -32602);
    assert.deepEqual(sent, []);
  });
});

describe("window.flush", () => {
  test("flush_requestAddress asks for a Grant when there is none, then answers the given-out address and the link network", async () => {
    const { handle, asked } = provider();
    assert.deepEqual(await handle(ORIGIN, "flush_requestAddress"), { network: "ecashbeta", address: ADDRESS });
    assert.deepEqual(asked.map((p) => [p.origin, p.slots, p.methods]), [[ORIGIN, [99], ["getAddresses", "sendTransfer"]]]);
    // Granted now: no second prompt.
    await handle(ORIGIN, "flush_requestAddress");
    assert.equal(asked.length, 1);
  });

  test("a refused Grant reads as flush.markets takes it quietly", async () => {
    const { handle } = provider({ connect: false });
    await assert.rejects(handle(ORIGIN, "flush_requestAddress"), (e) => e.code === 4001 && e.message === "User rejected.");
  });

  test("flush_submit is sendAction on Flush's Slot, and a rejected trade reads the same", async () => {
    const { handle, sent } = provider({ grant: granted(["getAddresses", "sendTransfer"]) });
    assert.deepEqual(await handle(ORIGIN, "flush_submit", { uri: LINK }), { txid: "ab".repeat(32) });
    assert.deepEqual(sent, [{ slot: 99, action: LINK, from: { origin: ORIGIN } }]);

    const rejecting = provider({
      grant: granted(["sendTransfer"]),
      trade: async () => {
        throw new wallet.ProviderRpcError(4001, "The user rejected the request.");
      },
    });
    await assert.rejects(rejecting.handle(ORIGIN, "flush_submit", { uri: LINK }), (e) => e.code === 4001 && e.message === "User rejected.");
  });

  test("flush_submit without a Grant is 4100, its message for the site to show", async () => {
    const { handle, sent } = provider();
    await assert.rejects(handle(ORIGIN, "flush_submit", { uri: LINK }), (e) => e.code === 4100 && /connect first/.test(e.message));
    assert.deepEqual(sent, []);
  });
});
