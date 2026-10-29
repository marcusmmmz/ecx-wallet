// The shared router runs without extension globals; transport identity stays outside messages.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as esbuild from "esbuild";
import { importWallet } from "../harness.mjs";

const { createMemoryStore, ErrorCode } = await importWallet();
const out = await esbuild.build({
  entryPoints: [new URL("../../extension/src/router.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
});
const { createRouter } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

function routerWith() {
  const deadlines = [];
  const scheduled = [];
  const host = {
    persistent: createMemoryStore(),
    session: createMemoryStore(),
    fetchWasm: async () => assert.fail("loaded WASM"),
    requester: (sender) => sender,
    scheduleAutoLock: async (deadline) => { scheduled.push(deadline); },
    openApproval: async () => assert.fail("opened approval"),
    announceDeadline: async (deadline) => { deadlines.push(deadline); },
    announceChains: async () => {},
    applyPinned: async () => {},
  };
  return { router: createRouter(host), host, deadlines, scheduled };
}
const walletPage = { walletPage: true };

test("the router trusts transport identity and refuses an unverified Provider origin", async () => {
  const { router } = routerWith();
  await assert.rejects(router.route({ kind: "settings.unit", walletPage: true }, { walletPage: false }), (e) => e.code === ErrorCode.Unauthorized);
  await assert.rejects(router.route({ kind: "provider.request", method: "getGrant", origin: "https://fake.example" }, walletPage), (e) => e.code === ErrorCode.Unauthorized);
  assert.equal(await router.route({ kind: "approval.get", id: "missing" }, { walletPage: false }), null);
  assert.equal(await router.route({ kind: "settings.unit" }, walletPage), "ecx");
});

test("locking clears cached data before replying, keeps used links and announces the deadline", async () => {
  const { router, host, deadlines, scheduled } = routerWith();
  await host.session.set("cache:balance:chain", { balance: 1 });
  await host.session.set("cache:tx:123", "bytes");
  await host.session.set("usedLink:123", true);
  await router.route({ kind: "vault.lock" }, walletPage);
  assert.deepEqual(await host.session.keys(), ["usedLink:123"]);
  assert.deepEqual(scheduled, [null]);
  assert.deepEqual(deadlines, [null]);
});

test("Grant listing and revocation use persistent keys, with tab broadcasts optional", async () => {
  const { router, host } = routerWith();
  const grant = (origin) => ({ origin, slots: [24], methods: ["getAddresses"], blindSigning: false });
  const a = grant("https://a.example");
  const b = grant("https://b.example");
  await host.persistent.set(`grant:${b.origin}`, b);
  await host.persistent.set("settings:unit", "sats");
  await host.persistent.set(`grant:${a.origin}`, a);
  assert.deepEqual(await router.route({ kind: "grants.list" }, walletPage), [a, b]);
  await router.route({ kind: "grants.revoke", origin: a.origin }, walletPage);
  assert.deepEqual(await router.route({ kind: "grants.list" }, walletPage), [b]);
  assert.equal(await host.persistent.get("settings:unit"), "sats");
});
