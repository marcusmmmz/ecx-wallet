// The chain tree (docs/adr/0003), checked on the shipped modules in node: the bundled Chain Entries
// agree with each other, and each module only ever gets the key its place in the tree calls for:
// eCash (the root) the L1 Account Key, a Slot under it that Slot's Starter.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { DIST_E2E, importWallet } from "../harness.mjs";

const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const SLOT_24_STARTER = "buyer citizen congress doll secret merry denial law live wait pass drive";
// BIP84's own vectors for ABANDON (bip-0084.mediawiki): m/84'/0'/0'/0/0 and /1/0.
const L1_RECEIVE_0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
const L1_CHANGE_0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el";

const wallet = await importWallet();
const load = async (file) => wallet.loadChainModule(await readFile(path.join(DIST_E2E.chromium, file)));
const [l1, elements, flush, vault] = await Promise.all([
  load("l1.wasm"),
  load("elements.wasm"),
  load("flush.wasm"),
  readFile(path.join(DIST_E2E.chromium, "vault.wasm")).then(wallet.loadVaultModule),
]);
const L1_ACCOUNT_KEY = vault.l1AccountKey(ABANDON, "");

describe("the bundled Chain Entries", () => {
  const entries = [l1.chainEntry(), elements.chainEntry(), flush.chainEntry()];

  test("each network has exactly one root, the main chain (eCash), with neither a Slot nor a parent", () => {
    for (const name of ["betanet"]) {
      const roots = entries.filter((e) => e.slot === undefined && e.networks[name]?.parent === undefined);
      assert.deepEqual(roots.map((e) => e.name), ["Main chain"]);
    }
    assert.equal(l1.chainEntry().networks.betanet.chain, "ecash:betanet");
  });

  test("every other chain has a Slot and a parent that is a bundled chain", () => {
    const chains = new Map(entries.flatMap((e) => Object.values(e.networks).map((n) => [n.chain, n])));
    for (const entry of entries.filter((e) => e.slot !== undefined)) {
      for (const network of Object.values(entry.networks)) {
        assert.ok(network.parent, `${network.chain} has a Slot but no parent`);
        assert.ok(chains.has(network.parent), `${network.chain}'s parent ${network.parent} isn't bundled`);
      }
    }
  });

  test("Elements' copy of its parent's address params equals the parent's own", () => {
    for (const [name, network] of Object.entries(elements.chainEntry().networks)) {
      const parent = Object.values(l1.chainEntry().networks).find((n) => n.chain === network.parent);
      assert.deepEqual(network.params.parentAddressParams, parent.params.addressParams, `${name}`);
    }
  });

  test("Elements is identified by its genesis, eCash betanet by its fork block", () => {
    const { identityBlock, params } = elements.chainEntry().networks.betanet;
    assert.deepEqual(identityBlock, { height: 0, hash: params.genesisHash });
    assert.deepEqual(l1.chainEntry().networks.betanet.identityBlock, {
      height: 967680,
      hash: "00000000000000030101ba5cfea54b22becc79f95dc6040beb76e01dd9d04042",
    });
  });

  test("Flush on betanet is Slot 99, identified by its own genesis, and its ECX is its native coin", () => {
    const entry = flush.chainEntry();
    assert.equal(entry.networks.betanet.slot, 99);
    assert.deepEqual(entry.networks.betanet.identityBlock, { height: 0, hash: "04dfb01bef61e44d679132f9e830719c64241f7052880418a350ff6d3c90b561" });
    assert.equal(entry.networks.betanet.sidechainServer.api, "flush");
    assert.deepEqual(entry.networks.betanet.assets.find((a) => a.ecx)?.id, "", "the empty id, as eCash's (docs/adr/0005)");
  });

  test("every bundled Slot is one the wallet ships a module for, and no two share a Slot", () => {
    const slots = entries.filter((e) => e.slot !== undefined).map((e) => e.slot);
    assert.deepEqual(slots, [...new Set(slots)]);
    assert.deepEqual(slots.sort((a, b) => a - b), [...wallet.SUPPORTED_SLOTS].sort((a, b) => a - b));
  });
});

describe("key routing", () => {
  /** Accounts over spying modules: what key each module got, and which key each Vault call gave out. */
  function spied({ l1Entry = l1.chainEntry(), elementsEntry = elements.chainEntry() } = {}) {
    const calls = [];
    const spy = (name, module, entry) => ({
      ...module,
      chainEntry: () => structuredClone(entry),
      deriveAccount: (key, options) => {
        calls.push(`${name} got ${key === L1_ACCOUNT_KEY ? "the L1 Account Key" : key === SLOT_24_STARTER ? "the Slot 24 Starter" : key}`);
        return module.deriveAccount(key, options);
      },
    });
    const accounts = wallet.createAccounts({
      starter: async (slot) => (calls.push(`Starter ${slot} given out`), SLOT_24_STARTER),
      l1AccountKey: async () => (calls.push("L1 Account Key given out"), L1_ACCOUNT_KEY),
      chainModule: (slot) => (slot === 24 ? Promise.resolve(spy("elements", elements, elementsEntry)) : undefined),
      l1Module: async () => spy("l1", l1, l1Entry),
    });
    return { accounts, calls };
  }

  test("the L1 module derives BIP84's addresses from the Vault's L1 Account Key", () => {
    assert.match(L1_ACCOUNT_KEY, /^\[73c5da0a\/84h\/0h\/0h\]xprv/);
    const account = l1.deriveAccount(L1_ACCOUNT_KEY, { receive: 1, change: 1 });
    assert.equal(account.receive[0].address, L1_RECEIVE_0);
    assert.equal(account.change[0].address, L1_CHANGE_0);
  });

  test("eCash's module gets the L1 Account Key and nothing else; no Starter is given out", async () => {
    const { accounts, calls } = spied();
    // BIP84's vector for m/84'/0'/0'/0/0.
    const publicKey = "0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c";
    assert.deepEqual(await accounts.l1ReceiveAddresses(), [{ chain: "ecash:betanet", address: L1_RECEIVE_0, publicKey }]);
    assert.deepEqual(calls, ["L1 Account Key given out", "l1 got the L1 Account Key"]);
  });

  test("Slot 24's module gets its Starter and nothing else; the L1 Account Key isn't given out", async () => {
    const { accounts, calls } = spied();
    const [{ chain }] = await accounts.receiveAddresses(24);
    assert.equal(chain, "ecash:betanet-s24");
    assert.deepEqual(calls, ["Starter 24 given out", "elements got the Slot 24 Starter"]);
  });

  test("each module refuses the other's key", () => {
    assert.throws(() => l1.deriveAccount(SLOT_24_STARTER, { receive: 1 }), /invalid L1 Account Key/);
    assert.throws(() => elements.deriveAccount(L1_ACCOUNT_KEY, { receive: 1 }), /Starter/);
    assert.throws(() => flush.deriveAccount(L1_ACCOUNT_KEY, { receive: 1 }), /invalid Starter/);
  });

  test("a chain nested under another Slot gets no key", async () => {
    const elementsEntry = structuredClone(elements.chainEntry());
    elementsEntry.networks.betanet.parent = "ecash:betanet-s9";
    const { accounts, calls } = spied({ elementsEntry });
    await assert.rejects(accounts.receiveAddresses(24), /no keys for nested chains/);
    assert.deepEqual(calls, []);
  });

  test("an L1 module whose entry isn't the root gets no L1 Account Key", async () => {
    const l1Entry = structuredClone(l1.chainEntry());
    l1Entry.slot = 1;
    l1Entry.networks.betanet.parent = "ecash:betanet";
    const { accounts, calls } = spied({ l1Entry });
    await assert.rejects(accounts.l1ReceiveAddresses(), /isn't the root chain/);
    assert.deepEqual(calls, []);
  });
});
