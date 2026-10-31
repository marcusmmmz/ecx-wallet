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

test("the web Worker refuses claimed dApp origins, takes an app's only from appRequest, and excludes Slot 24 at the router", async () => {
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
    // From the Provider window, the request reaches the Provider handler as that origin's.
    const fromApp = await new Promise((resolve) => {
      pending.set(++id, resolve);
      receive({ data: { type: "appRequest", id, origin: "https://app.example", method: "eth_accounts" } });
    });
    assert.equal(fromApp.ok, false);
    assert.equal(fromApp.error.code, 4200);
    // A `slot` Number() can't convert is refused as a reply, not a crashed Worker.
    const odd = await new Promise((resolve) => {
      pending.set(++id, resolve);
      receive({ data: { type: "appRequest", id, origin: "https://app.example", method: "sendTransfer", params: { slot: { toString: "x", valueOf: "x" } } } });
    });
    assert.equal(odd.ok, false);
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

test("the Provider window answers only its opener, as the origin the browser reports", async () => {
  const saved = { Worker: globalThis.Worker, document: globalThis.document, location: globalThis.location, window: globalThis.window, BroadcastChannel: globalThis.BroadcastChannel };
  const CHANNEL = "ecx:webWallet";
  // In memory, as the browser's: delivered to every other channel of that name. (Node's real one
  // would keep the test process alive.)
  const channels = new Set();
  globalThis.BroadcastChannel = class {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) { for (const c of channels) if (c !== this && c.name === this.name) c.onmessage?.({ data }); }
  };
  const toOpener = [];
  const opener = { postMessage: (message, origin) => toOpener.push([message, origin]) };
  let receive;
  let worker;
  const sent = [];
  globalThis.window = { opener: null, addEventListener: (_name, listener) => { receive = listener; } };
  globalThis.location = { origin: "https://wallet.example", hash: "#/provider" };
  globalThis.document = { visibilityState: "visible", addEventListener() {} };
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(message) { sent.push(message); }
    terminate() {}
  };
  try {
    const web = await load({
      entryPoints: [`${root}app/src/lib/platform/web.ts`],
      define: { "import.meta.url": '"https://wallet.example/module.js"' },
      plugins: [{ name: "navigation", setup(build) {
        build.onResolve({ filter: /^\$app\/navigation$/ }, () => ({ path: "navigation", namespace: "test" }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const goto = async () => {};" }));
      } }],
    });
    const seen = [];
    assert.equal(web.serveOpener((origin) => seen.push(origin)), false, "no page opened this one");
    globalThis.window.opener = opener;
    assert.equal(web.serveOpener((origin) => seen.push(origin)), true);
    assert.deepEqual(toOpener, [[{ channel: CHANNEL, type: "ready" }, "*"]]);

    // The message claims an origin of its own; only the browser's counts.
    const data = { channel: CHANNEL, type: "request", id: "r1", method: "connect", params: { origin: "https://forged.example" } };
    receive({ source: {}, origin: "https://app.example", data });
    receive({ source: opener, origin: "null", data });
    receive({ source: opener, origin: "https://wallet.example", data });
    receive({ source: opener, origin: "https://app.example", data: { ...data, channel: "other" } });
    assert.equal(sent.length, 0, "not the opener, an opaque origin, the wallet's own, or another channel");
    receive({ source: opener, origin: "https://app.example", data });
    const forwarded = sent.at(-1);
    assert.deepEqual(forwarded, { type: "appRequest", id: forwarded.id, origin: "https://app.example", method: "connect", params: data.params });
    assert.deepEqual(seen, ["https://app.example"]);

    worker.onmessage({ data: { type: "response", id: forwarded.id, response: { ok: true, result: "granted" } } });
    assert.deepEqual(toOpener.at(-1), [{ channel: CHANNEL, type: "response", id: "r1", response: { ok: true, result: "granted" } }, "https://app.example"]);
    worker.onmessage({ data: { type: "announce", message: { kind: "grantChanged", origin: "https://other.example", scope: null } } });
    assert.equal(toOpener.length, 2, "another origin's Grant change isn't passed on");
    worker.onmessage({ data: { type: "announce", message: { kind: "grantChanged", origin: "https://app.example", scope: null } } });
    assert.deepEqual(toOpener.at(-1), [{ channel: CHANNEL, type: "event", event: "grantChanged", payload: null }, "https://app.example"]);
    // Another tab's Worker revoked it: that page broadcasts it.
    new BroadcastChannel("ecx-wallet:grantChanged").postMessage({ kind: "grantChanged", origin: "https://app.example", scope: { slots: [99], methods: [] } });
    assert.deepEqual(toOpener.at(-1), [{ channel: CHANNEL, type: "event", event: "grantChanged", payload: { slots: [99], methods: [] } }, "https://app.example"]);
    assert.equal(toOpener.length, 4);
    // An app that reloaded finds this window open and says hello; only its opener gets an answer.
    receive({ source: {}, origin: "https://app.example", data: { channel: CHANNEL, type: "hello" } });
    receive({ source: opener, origin: "https://app.example", data: { channel: CHANNEL, type: "hello" } });
    assert.deepEqual(toOpener.slice(4), [[{ channel: CHANNEL, type: "ready" }, "*"]]);

    // The route mounts again after each approval: no second `ready`, and it hears the origins so far.
    const again = [];
    assert.equal(web.serveOpener((origin) => again.push(origin)), true);
    assert.equal(toOpener.length, 5);
    assert.deepEqual(again, ["https://app.example"]);
  } finally {
    Object.assign(globalThis, saved);
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
        options.signal?.throwIfAborted();
        return run();
      });
      queues.set(name, result.catch(() => {}));
      return result;
    },
  } } });
  const senders = [];
  globalThis.webWorkerTestRouter = (page) => ({
    connectApprovalHost() {},
    route(message, sender) {
      routed.push([page, message.kind]);
      senders.push(sender);
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

    // An app's Send through a Provider window queues behind the page's own Send on the same Slot.
    const app = (page, id, method, params) => receivers[page - 1]({ data: { type: "appRequest", id, origin: "https://app.example", method, params } });
    send(1, 6, "send.start");
    app(2, 7, "sendTransfer", { slot: 99 });
    app(2, 8, "getGrant");
    await tick();
    assert.deepEqual(locks.slice(-2), ["ecx-wallet:spend:99", "ecx-wallet:spend:99"], "getGrant takes no lock");
    // getGrant goes straight through; the page's Send holds the lock and the app's waits.
    const calls = routed.slice(-2).map(([page, kind], i) => ({ page, kind, sender: senders.at(-2 + i), done: waiting.at(-2 + i) }));
    const own = calls.find((c) => c.kind === "send.start");
    const grant = calls.find((c) => c.kind === "provider.request");
    assert.deepEqual([own.page, own.sender], [1, undefined], "the page's own requests carry no app origin");
    assert.deepEqual([grant.page, grant.sender], [2, { origin: "https://app.example" }]);
    grant.done.resolve(null);
    own.done.resolve({ txid: "page" });
    await tick();
    assert.deepEqual(routed.at(-1), [2, "provider.request"]);
    assert.deepEqual(senders.at(-1), { origin: "https://app.example" });
    waiting.at(-1).resolve({ txid: "app" });
    await tick();
    assert.deepEqual(responses.find((r) => r.id === 7).response, { ok: true, result: { txid: "app" } });
  } finally {
    globalThis.self = savedSelf;
    if (savedNavigator) Object.defineProperty(globalThis, "navigator", savedNavigator);
    else delete globalThis.navigator;
    delete globalThis.webWorkerTestRouter;
  }
});
