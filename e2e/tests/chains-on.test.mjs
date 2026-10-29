// Turning chains on and off (no browser needed). The main chain is always on; a sidechain is off
// until the user turns it on, and an app asking for one that's off turns it on only after the
// user approves.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { importWallet } from "../harness.mjs";

const { createSettings, createProviderHandler } = await importWallet();

const memoryStore = () => {
  const data = new Map();
  return { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v), remove: async (k) => void data.delete(k), keys: async () => [...data.keys()] };
};

describe("the chain setting", () => {
  test("a chain is off until turned on, and stays as the user left it, per chain id", async () => {
    const store = memoryStore();
    const settings = createSettings(store);
    assert.equal(await settings.chainOn("ecash:betanet-s24"), false);
    await settings.setChainOn("ecash:betanet-s24", true);
    assert.equal(await createSettings(store).chainOn("ecash:betanet-s24"), true);
    assert.equal(await createSettings(store).chainOn("ecash:mainnet-s24"), false, "another network's Slot 24 is another chain");
    await settings.setChainOn("ecash:betanet-s24", false);
    assert.equal(await createSettings(store).chainOn("ecash:betanet-s24"), false);
  });
});

/** A Provider handler over fakes: Slot 24 supported, its chain off unless `on`; records prompts. */
function provider({ on = false, approveConnect = true, approveTurnOn = true, grant } = {}) {
  const state = { on, prompts: [], addressesAsked: 0 };
  const grants = new Map(grant ? [[grant.origin, grant]] : []);
  const handle = createProviderHandler({
    grants: {
      get: async (o) => grants.get(o),
      put: async (g) => void grants.set(g.origin, g),
      remove: async (o) => void grants.delete(o),
      list: async () => [...grants.values()],
    },
    supportedSlots: [24],
    isUnlocked: async () => true,
    now: () => Date.now(),
    chains: { isOn: async () => state.on, turnOn: async () => void (state.on = true) },
    askToConnect: async (prompt) => {
      state.prompts.push({ kind: "connect", ...prompt });
      return { approved: approveConnect, blindSigning: false };
    },
    askToTurnOn: async (prompt) => {
      state.prompts.push({ kind: "turnOn", ...prompt });
      return approveTurnOn;
    },
    receiveAddresses: async () => {
      state.addressesAsked++;
      return [{ chain: "ecash:betanet-s24", address: "elements1q…" }];
    },
  });
  return { handle, state };
}

const ORIGIN = "https://app.example";
const GRANT = { origin: ORIGIN, slots: [24], methods: ["getAddresses", "signTransaction"] };

describe("an app asking for a chain that's off", () => {
  test("connect's own prompt says approving turns it on, and approving does", async () => {
    const { handle, state } = provider();
    await handle(ORIGIN, "connect", { slots: [24], methods: ["getAddresses"] });
    assert.deepEqual(state.prompts.map((p) => [p.kind, p.turnsOn]), [["connect", [24]]]);
    assert.equal(state.on, true);
  });

  test("rejecting connect leaves it off", async () => {
    const { handle, state } = provider({ approveConnect: false });
    await assert.rejects(handle(ORIGIN, "connect", { slots: [24], methods: ["getAddresses"] }), (e) => e.code === 4001);
    assert.equal(state.on, false);
  });

  test("connect with a Grant that already covers it asks only to turn it on", async () => {
    const { handle, state } = provider({ grant: GRANT });
    await handle(ORIGIN, "connect", { slots: [24], methods: ["getAddresses"] });
    assert.deepEqual(state.prompts, [{ kind: "turnOn", origin: ORIGIN, slots: [24] }]);
    assert.equal(state.on, true);
  });

  test("getAddresses asks to turn it on first; refused, the app gets 4001 and no address", async () => {
    const { handle, state } = provider({ grant: GRANT, approveTurnOn: false });
    await assert.rejects(handle(ORIGIN, "getAddresses", { slot: 24 }), (e) => e.code === 4001);
    assert.deepEqual(state.prompts, [{ kind: "turnOn", origin: ORIGIN, slots: [24] }]);
    assert.equal(state.addressesAsked, 0);
    assert.equal(state.on, false);
  });

  test("getAddresses, approved, turns it on and answers", async () => {
    const { handle, state } = provider({ grant: GRANT });
    assert.equal((await handle(ORIGIN, "getAddresses", { slot: 24 })).length, 1);
    assert.equal(state.on, true);
  });

  test("a chain that's on asks nothing more", async () => {
    const { handle, state } = provider({ on: true, grant: GRANT });
    await handle(ORIGIN, "connect", { slots: [24], methods: ["getAddresses"] });
    await handle(ORIGIN, "getAddresses", { slot: 24 });
    assert.deepEqual(state.prompts, []);
  });

  test("an origin with no Grant is refused before any prompt to turn a chain on", async () => {
    const { handle, state } = provider();
    await assert.rejects(handle(ORIGIN, "getAddresses", { slot: 24 }), (e) => e.code === 4100);
    assert.deepEqual(state.prompts, []);
  });
});
