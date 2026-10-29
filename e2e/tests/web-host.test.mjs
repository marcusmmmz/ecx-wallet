// Web host boundaries, without a browser or a local server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import * as esbuild from "esbuild";
import { chainEntries, moduleFiles, webChains } from "../../app/scripts/web-config.mjs";
import { sidechainServerOrigins } from "../../extension/scripts/chain-origins.mjs";

const root = new URL("../../", import.meta.url).pathname;
const load = async (options) => {
  const out = await esbuild.build({ bundle: true, format: "esm", platform: "neutral", write: false, ...options });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};

test("web chains exclude Elements from the registry and server origins", async () => {
  assert.deepEqual(moduleFiles, { 99: "flush.wasm" });
  assert.deepEqual(await sidechainServerOrigins(chainEntries), ["https://esplora.beta.ecash.ninja", "https://explorer.blockfab.org"]);
});

test("the web Worker refuses claimed dApp origins and excludes Slot 24 at the router", async () => {
  const previous = globalThis.self;
  const pending = new Map();
  let receive;
  globalThis.self = {
    addEventListener: (_name, listener) => { receive = listener; },
    postMessage: (message) => {
      if (message.type === "response") pending.get(message.id)(message.response);
    },
  };
  try {
    await load({
      entryPoints: [`${root}app/src/lib/platform/worker.ts`],
      define: { "import.meta.env.BASE_URL": '"/"' },
      plugins: [{ name: "web-host-test", setup(build) {
        build.onLoad({ filter: /wallet\/src\/module-files\.ts$/ }, async ({ path }) => ({
          contents: webChains().transform(await readFile(path, "utf8"), path), loader: "ts",
        }));
      } }],
    });
    let id = 0;
    const request = (message) => new Promise((resolve) => {
      pending.set(++id, resolve);
      receive({ data: { type: "request", id, message } });
    });
    const response = await request({ kind: "provider.request", method: "getGrant", origin: "https://forged.example", walletPage: true });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 4100);
    const excluded = await request({ kind: "chains.setOn", slot: 24, on: true });
    assert.equal(excluded.ok, false);
    assert.equal(excluded.error.code, 4901);
    assert.equal(excluded.error.message, "No Chain Module for that Slot.");
  } finally {
    globalThis.self = previous;
  }
});

test("web transport matches replies by id, relays ports and announcements, and returns from approvals", async () => {
  const saved = { Worker: globalThis.Worker, document: globalThis.document, location: globalThis.location };
  let worker;
  let visibility;
  const navigations = [];
  const sent = [];
  globalThis.location = { hash: "#/chain/99" };
  globalThis.document = { visibilityState: "hidden", addEventListener: (_name, listener) => { visibility = listener; } };
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(message) { sent.push(message); }
    terminate() {}
  };
  globalThis.webHostTestGoto = async (hash) => { navigations.push(hash); globalThis.location.hash = hash; };
  try {
    const web = await load({
      entryPoints: [`${root}app/src/lib/platform/web.ts`],
      define: { "import.meta.url": '"https://wallet.example/module.js"' },
      plugins: [{ name: "navigation", setup(build) {
        build.onResolve({ filter: /^\$app\/navigation$/ }, () => ({ path: "navigation", namespace: "test" }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const goto = (...args) => globalThis.webHostTestGoto(...args);" }));
      } }],
    });
    const emit = (data) => worker.onmessage({ data });
    const first = web.request({ kind: "vault.status" });
    const second = web.request({ kind: "chains.list" });
    emit({ type: "response", id: sent[1].id, response: { ok: true, result: "second" } });
    emit({ type: "response", id: sent[0].id, response: { ok: true, result: "first" } });
    assert.equal((await first).result, "first");
    assert.equal((await second).result, "second");
    const announcements = [];
    const stop = web.onMessage((message) => announcements.push(message));
    emit({ type: "announce", message: { kind: "vault.deadline", locksAt: null } });
    stop();
    emit({ type: "announce", message: { kind: "chains.changed", ids: [99] } });
    assert.deepEqual(announcements, [{ kind: "vault.deadline", locksAt: null }]);
    const shown = [];
    let disconnected = 0;
    const port = web.connect("approval.host:test");
    const portId = sent.at(-1).id;
    port.onMessage.addListener((message) => shown.push(message));
    port.onDisconnect.addListener(() => disconnected++);
    emit({ type: "portMessage", id: portId, message: { id: "approval" } });
    assert.deepEqual(shown, [{ id: "approval" }]);
    port.disconnect();
    port.disconnect();
    assert.equal(disconnected, 1);
    assert.equal(sent.at(-1).type, "disconnect");
    emit({ type: "openApproval", id: "one" });
    web.approvalRouteChanged("/approve/one");
    emit({ type: "closeApproval", id: "one" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(navigations, ["#/approve/one", "#/chain/99"]);
    emit({ type: "openApproval", id: "two" });
    globalThis.location.hash = "#/settings";
    web.approvalRouteChanged("/settings");
    assert.deepEqual(sent.at(-1), { type: "approvalClosed", id: "two" });
    emit({ type: "closeApproval", id: "two" });
    assert.equal(globalThis.location.hash, "#/settings");
    let finishOpening;
    globalThis.webHostTestGoto = (hash) => new Promise((resolve) => {
      finishOpening = () => { globalThis.location.hash = hash; resolve(); };
    });
    emit({ type: "openApproval", id: "fast" });
    emit({ type: "closeApproval", id: "fast" });
    globalThis.webHostTestGoto = async (hash) => { globalThis.location.hash = hash; };
    finishOpening();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(globalThis.location.hash, "#/settings", "closing before navigation finishes still returns to the previous route");
    globalThis.document.visibilityState = "visible";
    visibility();
    assert.deepEqual(sent.at(-1), { type: "checkAutoLock" });
    assert.equal(web.currentView(), "page");
    assert.equal(web.canPin(), false);
  } finally {
    Object.assign(globalThis, saved);
    delete globalThis.webHostTestGoto;
  }
});
