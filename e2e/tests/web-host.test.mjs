// Web host boundaries, without a browser or a local server.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";
import { chains, webChains } from "../../app/scripts/web-config.mjs";
import { moduleFilesSource, sidechainServerOrigins } from "../../core/scripts/chains.mjs";

const root = new URL("../../", import.meta.url).pathname;
const load = async (options) => {
  const out = await esbuild.build({ bundle: true, format: "esm", platform: "neutral", write: false, ...options });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
};

test("web chains exclude Elements from the registry and server origins", async () => {
  assert.equal(moduleFilesSource(chains), 'export const CHAIN_MODULE_FILES = {"99":"flush.wasm"};');
  assert.deepEqual(sidechainServerOrigins(chains), ["https://esplora.beta.ecash.ninja", "https://explorer.blockfab.org"]);
});

test("the mainnet web build bundles Flush as Slot 46 and reaches only mainnet's servers", () => {
  const script = `const { chains } = await import(${JSON.stringify(`${root}app/scripts/web-config.mjs`)});
    const { moduleFilesSource, sidechainServerOrigins } = await import(${JSON.stringify(`${root}core/scripts/chains.mjs`)});
    console.log(JSON.stringify([moduleFilesSource(chains), sidechainServerOrigins(chains)]));`;
  const env = { ...process.env, ECX_NETWORK: "mainnet" };
  delete env.ECX_CHAIN_ENTRIES;
  const [source, origins] = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { env }).toString());
  assert.equal(source, 'export const CHAIN_MODULE_FILES = {"46":"flush.wasm"};');
  assert.deepEqual(origins, ["https://explorer.blockfab.org", "https://explorer.ecash.ninja"]);
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
    // A completed request's return must not interrupt a newer approval still opening.
    let finishOld;
    let finishNew;
    globalThis.webHostTestGoto = (hash) => new Promise((resolve) => {
      const finish = () => { globalThis.location.hash = hash; resolve(); };
      if (hash === "#/approve/old") finishOld = finish;
      else finishNew = finish;
    });
    emit({ type: "openApproval", id: "old" });
    emit({ type: "closeApproval", id: "old" });
    emit({ type: "openApproval", id: "new" });
    finishOld();
    await new Promise((resolve) => setImmediate(resolve));
    finishNew();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(globalThis.location.hash, "#/approve/new");
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

test("web Workers serialize Sends and Deposits across pages and release the lock on failure", async () => {
  const savedSelf = globalThis.self;
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const receivers = [];
  const responses = [];
  const routed = [];
  const waiting = [];
  const locks = [];
  const queues = new Map();
  globalThis.self = {
    addEventListener: (_name, listener) => receivers.push(listener),
    postMessage: (message) => responses.push(message),
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { locks: {
    request(name, options, run) {
      locks.push(name);
      const result = (queues.get(name) ?? Promise.resolve()).then(() => {
        options.signal.throwIfAborted();
        return run();
      });
      queues.set(name, result.catch(() => {}));
      return result;
    },
  } } });
  globalThis.webWorkerTestRouter = (page) => ({
    connectApprovalHost() {},
    route(message) {
      routed.push([page, message.kind]);
      if (message.kind === "vault.status") return Promise.resolve("locked");
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    toErrorResponse: (error) => ({ ok: false, error: { code: 4001, message: error.message } }),
  });
  try {
    for (const page of [1, 2]) await load({
      entryPoints: [`${root}app/src/lib/platform/worker.ts`],
      plugins: [{ name: "router", setup(build) {
        build.onResolve({ filter: /extension\/src\/router$/ }, () => ({ path: "router", namespace: "test" }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
          contents: `export const createRouter = () => globalThis.webWorkerTestRouter(${page});`,
        }));
      } }],
    });
    const send = (page, id, kind, extra = {}) => receivers[page - 1]({ data: { type: "request", id, message: { kind, slot: 99, ...extra } } });
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    send(1, 1, "send.start");
    send(2, 2, "send.start", { slot: "099" });
    send(2, 3, "vault.status");
    await tick();
    assert.deepEqual(locks, ["ecx-wallet:spend:99", "ecx-wallet:spend:99"]);
    assert.deepEqual(routed, [[2, "vault.status"], [1, "send.start"]]);
    assert.equal(responses[0].id, 3, "reads do not wait for another tab's approval");
    waiting[0].reject(new Error("User rejected."));
    await tick();
    assert.deepEqual(routed.at(-1), [2, "send.start"]);
    assert.equal(responses.find((r) => r.id === 1).response.ok, false);
    waiting[1].resolve({ txid: "sent" });
    await tick();
    assert.deepEqual(responses.find((r) => r.id === 2).response, { ok: true, result: { txid: "sent" } });
    send(1, 4, "deposit.start", { slot: 24 });
    receivers[1]({ data: { type: "connect", id: 10, name: "approval.host:leaving" } });
    send(2, 5, "deposit.start", { host: "leaving" });
    await tick();
    assert.deepEqual(locks.slice(-2), ["ecx-wallet:spend:l1", "ecx-wallet:spend:l1"], "Deposits to different Slots share L1 coins");
    assert.deepEqual(routed.slice(-1), [[1, "deposit.start"]]);
    receivers[1]({ data: { type: "disconnect", id: 10 } });
    waiting[2].resolve({ txid: "deposited" });
    await tick();
    assert.deepEqual(routed.slice(-1), [[1, "deposit.start"]], "a form closed while queued never reaches the router");
    assert.equal(responses.find((r) => r.id === 5).response.error.code, 4001);
  } finally {
    globalThis.self = savedSelf;
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete globalThis.navigator;
    delete globalThis.webWorkerTestRouter;
  }
});
