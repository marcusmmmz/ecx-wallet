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
    assert.deepEqual(toOpener.slice(4), [[{ channel: CHANNEL, type: "ready" }, "https://app.example"]]);

    // The route mounts again after each approval: no second `ready`, and it hears the origins so far.
    const again = [];
    assert.equal(web.serveOpener((origin) => again.push(origin)), true);
    assert.equal(toOpener.length, 5);
    assert.deepEqual(again, ["https://app.example"]);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("the Apps view serves its frame as the origin of the frame's latest message, and draws approvals over it", async () => {
  const saved = { Worker: globalThis.Worker, document: globalThis.document, location: globalThis.location, window: globalThis.window, BroadcastChannel: globalThis.BroadcastChannel };
  const CHANNEL = "ecx:webWallet";
  const channels = new Set();
  globalThis.BroadcastChannel = class {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) { for (const c of channels) if (c !== this && c.name === this.name) c.onmessage?.({ data }); }
    close() { channels.delete(this); }
  };
  const listeners = new Set();
  globalThis.window = { opener: null, addEventListener: (_name, l) => listeners.add(l), removeEventListener: (_name, l) => listeners.delete(l) };
  const receive = (event) => listeners.forEach((l) => l(event));
  globalThis.location = { origin: "https://wallet.example", hash: "#/apps?url=x" };
  globalThis.document = { visibilityState: "visible", addEventListener() {} };
  let worker;
  const sent = [];
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(message) { sent.push(message); }
    terminate() {}
  };
  const navigations = [];
  globalThis.webHostTestGoto = async (hash) => navigations.push(hash);
  const toFrame = [];
  const contentWindow = { postMessage: (message, origin) => toFrame.push([message, origin]) };
  let onLoad;
  const frame = { contentWindow, addEventListener: (_name, l) => (onLoad = l), removeEventListener: () => (onLoad = undefined) };
  try {
    // A bundle of its own (the banner): an identical one would be the module already imported,
    // with an earlier test's Worker.
    const web = await load({
      entryPoints: [`${root}app/src/lib/platform/web.ts`],
      banner: { js: "// Apps view" },
      define: { "import.meta.url": '"https://wallet.example/module.js"' },
      plugins: [{ name: "navigation", setup(build) {
        build.onResolve({ filter: /^\$app\/navigation$/ }, () => ({ path: "navigation", namespace: "test" }));
        build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const goto = (...args) => globalThis.webHostTestGoto(...args);" }));
      } }],
    });
    const origins = [];
    let loads = 0;
    const stop = web.serveFrame(frame, { origin: (o) => origins.push(o), loaded: () => loads++ });
    const hello = { channel: CHANNEL, type: "hello" };
    // Framed, the app says hello before its frame's load.
    receive({ source: contentWindow, origin: "https://app.example", data: hello });
    assert.deepEqual(toFrame, [[{ channel: CHANNEL, type: "ready" }, "https://app.example"]]);
    onLoad();
    assert.equal(loads, 1);
    assert.deepEqual(origins, ["https://app.example", undefined], "each load forgets the origin");
    assert.deepEqual(toFrame.at(-1), [hello, "*"], "and asks whichever page is there now");
    receive({ source: contentWindow, origin: "https://app.example", data: hello });
    const data = { channel: CHANNEL, type: "request", id: "r1", method: "connect", params: {} };
    receive({ source: {}, origin: "https://app.example", data });
    receive({ source: contentWindow, origin: "null", data });
    receive({ source: contentWindow, origin: "https://wallet.example", data });
    assert.equal(sent.length, 0, "not the frame, an opaque origin, or the wallet's own");
    receive({ source: contentWindow, origin: "https://app.example", data });
    assert.deepEqual(sent.at(-1), { type: "appRequest", id: sent.at(-1).id, origin: "https://app.example", method: "connect", params: {} });

    // The approval is drawn over the frame, and the route doesn't change.
    const shown = [];
    const unhost = web.hostApprovals((id) => shown.push(id));
    worker.onmessage({ data: { type: "openApproval", id: "a1" } });
    web.approvalRouteChanged("/apps");
    assert.deepEqual(shown, ["a1"]);
    assert.deepEqual(navigations, []);
    web.closeOverlayApproval("other");
    web.closeOverlayApproval("a1");
    assert.deepEqual(shown, ["a1", undefined]);
    assert.deepEqual(sent.at(-1), { type: "approvalClosed", id: "a1" });
    worker.onmessage({ data: { type: "openApproval", id: "a2" } });
    unhost();
    assert.deepEqual(shown, ["a1", undefined, "a2", undefined]);
    assert.deepEqual(sent.at(-1), { type: "approvalClosed", id: "a2" }, "leaving the view cancels it");
    worker.onmessage({ data: { type: "openApproval", id: "a3" } });
    assert.deepEqual(navigations, ["#/approve/a3"], "without the view, approvals open their route");

    // Grant changes reach the frame's current origin only.
    const grant = (origin) => {
      const channel = new BroadcastChannel("ecx-wallet:grantChanged");
      channel.postMessage({ kind: "grantChanged", origin, scope: null });
      channel.close();
    };
    const before = toFrame.length;
    grant("https://other.example");
    assert.equal(toFrame.length, before);
    grant("https://app.example");
    assert.deepEqual(toFrame.at(-1), [{ channel: CHANNEL, type: "event", event: "grantChanged", payload: null }, "https://app.example"]);
    // The frame went elsewhere: its new page hasn't spoken, so the app's origin hears nothing.
    onLoad();
    grant("https://app.example");
    assert.deepEqual(toFrame.at(-1), [hello, "*"]);
    receive({ source: contentWindow, origin: "https://evil.example", data: hello });
    assert.deepEqual(origins.at(-1), "https://evil.example");

    stop();
    assert.equal(onLoad, undefined);
    assert.equal(listeners.size, 0);
    assert.equal(channels.size, 0);
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
    // The main chain's Send names no Slot: it spends L1 coins, under the Deposits' lock.
    send(1, 20, "send.start", { slot: undefined });
    await tick();
    assert.equal(locks.at(-1), "ecx-wallet:spend:l1", "a main-chain Send shares the Deposits' lock");
    waiting.at(-1).resolve({ txid: "sent on l1" });
    await tick();
    assert.deepEqual(responses.find((r) => r.id === 20).response, { ok: true, result: { txid: "sent on l1" } });

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
