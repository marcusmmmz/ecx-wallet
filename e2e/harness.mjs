// Seam 1 harness: the built extension in a real headless browser, driven from outside.
//
// - puppeteer-core only, no Chrome download. Binaries: $BRAVE (default /usr/bin/brave),
//   $FIREFOX (default /usr/bin/firefox).
// - Throwaway profile in a fresh temp dir, deleted on close; never the user's profile.
// - Puppeteer never attaches to the extension's service worker (`targetFilter`): an attached
//   debugger keeps a stopped worker from restarting (see spike/elements-wasm RESULTS.md).
//   To stop the worker, use the Brave session's `stopServiceWorker()` (CDP
//   `ServiceWorker.stopWorker` over an extension page's session, as the spike did), or
//   `stopBackground()`, which both browsers' sessions offer.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import puppeteer from "puppeteer-core";
import { createStubServer } from "@ecx/stub-server";
import { createEsploraStub } from "@ecx/stub-server/esplora";
import { E2E_FLUSH_SERVER, E2E_L1_SERVER, E2E_SIDECHAIN_SERVER } from "./scripts/build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..");
export const DIST = {
  chromium: path.join(ROOT, "extension", "dist", "chromium"),
  firefox: path.join(ROOT, "extension", "dist", "firefox"),
};
/** The e2e build (e2e/scripts/build.mjs): the shipped build with Slot 24's server on loopback. */
export const DIST_E2E = {
  chromium: path.join(ROOT, "e2e", "dist", "extension", "chromium"),
  firefox: path.join(ROOT, "e2e", "dist", "extension", "firefox"),
};

/** Browsers the Provider suite runs against: `E2E_BROWSERS=brave,firefox` (the default). */
export const BROWSERS = (process.env.E2E_BROWSERS ?? "brave,firefox").split(",").filter(Boolean);

/**
 * Launches the named browser (one of BROWSERS) with the matching extension build installed: by
 * default the e2e build, whose Slot 24 server is on loopback (see `serveEsplora`), so no test
 * reaches the public explorer; `{ build: "shipped" }` for the shipped build. build-output.test
 * checks the two differ only in that server.
 */
export function launchWallet(name, { build = "e2e", ...options } = {}) {
  const dist = build === "shipped" ? DIST : DIST_E2E;
  if (name === "brave") return launchBrave({ extensionPath: dist.chromium, ...options });
  if (name === "firefox") return launchFirefox({ extensionPath: dist.firefox, ...options });
  throw new Error(`Unknown browser ${name}`);
}

/**
 * Launches headless Brave with the built Chromium extension installed.
 * Returns a session; always `await session.close()`.
 *
 * `profile`: reuse this profile dir (e.g. to restart the browser on the same profile); the caller
 * then owns it and `close()` leaves it in place. Default: a fresh throwaway profile.
 */
export async function launchBrave({ extensionPath = DIST_E2E.chromium, profile: reuse } = {}) {
  const profile = reuse ?? (await mkdtemp(path.join(tmpdir(), "ecx-e2e-brave-")));
  const keepProfile = reuse !== undefined;
  const browser = await puppeteer.launch({
    executablePath: process.env.BRAVE ?? "/usr/bin/brave",
    headless: process.env.HEADFUL ? false : true,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    targetFilter: (target) => target.type() !== "service_worker",
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-features=BraveRewards,BraveWallet,BraveNews",
      // Every *.localhost name is the test server, so each test can use its own web origin
      // (Grants are per origin) while staying a secure context.
      "--host-resolver-rules=MAP *.localhost 127.0.0.1",
    ],
  });
  let extensionId;
  try {
    // Developer mode turns on the extension error console, so runtime errors (CSP violations,
    // uncaught exceptions) are recorded and `extensionErrors()` can report them.
    await withExtensionsPage(browser, (page) =>
      page.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })),
    );
    extensionId = await browser.installExtension(extensionPath);
  } catch (error) {
    await closeBrowser(browser, keepProfile ? undefined : profile);
    throw error;
  }

  const extensionOrigin = `chrome-extension://${extensionId}/`;
  return {
    ...walletSession(browser, keepProfile ? undefined : profile, extensionOrigin),
    extensionId,

    /**
     * Stops the extension's service worker the way the browser's idle timeout does (CDP
     * `ServiceWorker.stopWorker` over an extension page's session, never by attaching to the
     * worker). Resolves with how many running worker versions were stopped once all are stopped.
     */
    async stopServiceWorker() {
      const page = await browser.newPage();
      try {
        // An extension page that sends no messages, so it doesn't wake the worker itself.
        await page.goto(`${extensionOrigin}manifest.json`);
        const cdp = await page.createCDPSession();
        const versions = new Map();
        cdp.on("ServiceWorker.workerVersionUpdated", ({ versions: updated }) => {
          for (const v of updated) versions.set(v.versionId, v);
        });
        await cdp.send("ServiceWorker.enable");
        await new Promise((r) => setTimeout(r, 300));
        const ours = () => [...versions.values()].filter((v) => v.scriptURL.startsWith(extensionOrigin));
        const running = ours().filter((v) => v.runningStatus !== "stopped");
        for (const v of running) await cdp.send("ServiceWorker.stopWorker", { versionId: v.versionId });
        for (let i = 0; ours().some((v) => v.runningStatus !== "stopped"); i++) {
          if (i > 50) throw new Error("The service worker did not stop");
          await new Promise((r) => setTimeout(r, 100));
        }
        return running.length;
      } finally {
        await page.close();
      }
    },

    /** The background, for tests that run on every browser, is the service worker. */
    stopBackground() {
      return this.stopServiceWorker();
    },

    /** Manifest errors, install warnings and runtime errors Brave recorded for the extension. */
    async extensionErrors() {
      const info = await withExtensionsPage(browser, (page) =>
        page.evaluate((id) => chrome.developerPrivate.getExtensionInfo(id), extensionId),
      );
      return {
        manifestErrors: info.manifestErrors ?? [],
        installWarnings: info.installWarnings ?? [],
        runtimeErrors: info.runtimeErrors ?? [],
      };
    },
  };
}

// Pins the Firefox extension's internal UUID so tests can open its pages (moz-extension://<uuid>/).
const FIREFOX_EXTENSION_ID = "wallet@ecx.invalid";
const FIREFOX_EXTENSION_UUID = "6c1f6e1e-ec0a-4c1b-9a51-ec0000000024";
const FIREFOX_EXTENSION_ORIGIN = `moz-extension://${FIREFOX_EXTENSION_UUID}/`;

/**
 * Launches headless Firefox over WebDriver BiDi with the built Firefox extension temporarily
 * installed. Same session shape as Brave's; `extensionErrors()` reads the extension's manifest
 * errors and warnings and every error the browser console records from the extension's scripts
 * and pages (Firefox has no extension error console API, so this runs in the browser's chrome
 * context, which `-remote-allow-system-access` opens to BiDi `script.evaluate`).
 *
 * `profile`: reuse this profile dir to restart the browser on it; the caller owns it. The add-on
 * is installed again on each launch (temporary add-ons don't survive a restart), keeping its
 * storage and UUID.
 */
export async function launchFirefox({ extensionPath = DIST_E2E.firefox, profile: reuse } = {}) {
  const profile = reuse ?? (await mkdtemp(path.join(tmpdir(), "ecx-e2e-firefox-")));
  const keepProfile = reuse !== undefined;
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath: process.env.FIREFOX ?? "/usr/bin/firefox",
    headless: process.env.HEADFUL ? false : true,
    userDataDir: profile,
    extraPrefsFirefox: {
      "extensions.webextensions.uuids": JSON.stringify({ [FIREFOX_EXTENSION_ID]: FIREFOX_EXTENSION_UUID }),
      // A temporary add-on is uninstalled when Firefox closes, and uninstalling deletes its
      // storage. Keeping it lets a relaunch on the same profile reinstall the add-on and find its
      // `storage.local` as a permanently installed add-on would (see "Firefox" in docs/testing.md).
      "extensions.webextensions.keepStorageOnUninstall": true,
      "extensions.webextensions.keepUuidOnUninstall": true,
    },
    // Needed to script moz-extension:// pages such as the approval window, and the chrome context.
    args: ["-remote-allow-system-access"],
    // A snap-launched parent (e.g. VS Code) leaks GTK/GIO paths that crash Firefox's content
    // processes (spike/elements-wasm RESULTS.md); drop them.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k, v]) => !/\/snap\//.test(v ?? "") && !k.startsWith("SNAP")),
    ),
  });
  let chrome;
  try {
    chrome = await firefoxChrome(browser);
    // Listen before installing, so errors raised while the extension starts are kept too.
    await chrome(`(() => {
      globalThis.ecxConsole = [];
      Services.console.registerListener({ observe: (message) => void globalThis.ecxConsole.push(message) });
    })()`);
    await browser.installExtension(extensionPath);
  } catch (error) {
    await closeBrowser(browser, keepProfile ? undefined : profile);
    throw error;
  }
  return {
    ...walletSession(browser, keepProfile ? undefined : profile, FIREFOX_EXTENSION_ORIGIN),

    /**
     * Stops the extension's background (a non-persistent event page in Firefox MV3) the way
     * Firefox's idle timeout does (`Extension.terminateBackground`). Resolves with how many
     * running backgrounds were stopped (0 or 1); the next extension event starts it again.
     */
    stopBackground: () =>
      chrome(`(async () => {
        const extension = WebExtensionPolicy.getByID(${JSON.stringify(FIREFOX_EXTENSION_ID)}).extension;
        if (extension.backgroundState !== "running") return 0;
        await extension.terminateBackground();
        if (extension.backgroundState !== "stopped") throw new Error("The background did not stop");
        return 1;
      })()`),

    /** Manifest errors and warnings, and errors the browser console recorded from the extension. */
    extensionErrors: () =>
      chrome(`(() => {
        const extension = WebExtensionPolicy.getByID(${JSON.stringify(FIREFOX_EXTENSION_ID)}).extension;
        const runtimeErrors = globalThis.ecxConsole
          .filter((m) => m instanceof Ci.nsIScriptError && !(m.flags & Ci.nsIScriptError.warningFlag))
          .filter((m) => m.sourceName.startsWith(${JSON.stringify(FIREFOX_EXTENSION_ORIGIN)}))
          .map((m) => ({ source: m.sourceName, line: m.lineNumber, category: m.category, message: m.errorMessage }));
        return { manifestErrors: [...extension.errors], installWarnings: [...extension.warnings], runtimeErrors };
      })()`),
  };
}

/**
 * Returns `evaluate(expression)` for Firefox's chrome (privileged browser UI) context: the
 * expression's value comes back JSON-serialised; promises are awaited.
 */
async function firefoxChrome(browser) {
  const tree = await browser.connection.send("browsingContext.getTree", { "moz:scope": "chrome" });
  const context = tree.result.contexts[0].context;
  return async (expression) => {
    const { result } = await browser.connection.send("script.evaluate", {
      expression: `Promise.resolve(${expression}).then((v) => JSON.stringify(v ?? null))`,
      target: { context },
      awaitPromise: true,
      resultOwnership: "none",
    });
    if (result.type !== "success") throw new Error(`chrome-context evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    return JSON.parse(result.result.value);
  };
}

/** What every browser session offers. `walletPrefix` identifies the wallet's own pages. */
function walletSession(browser, profile, walletPrefix) {
  const isApproval = (t) => t.url().startsWith(walletPrefix) && t.url().includes("#/approve/");
  // Over BiDi (Firefox), puppeteer neither reliably reports windows an extension opens nor drops
  // them from `targets()` once closed, so poll and probe each candidate for liveness.
  const dead = new WeakSet();
  async function liveApprovals() {
    const live = [];
    for (const target of browser.targets().filter((t) => isApproval(t) && !dead.has(t))) {
      const page = await target.asPage();
      const alive = await Promise.race([
        page.evaluate(() => true).catch(() => false),
        new Promise((r) => setTimeout(() => r(false), 2_000)),
      ]);
      if (alive) live.push(page);
      else dead.add(target);
    }
    return live;
  }

  const extensionUrl = (p) => `${walletPrefix}${p.replace(/^\//, "")}`;
  return {
    browser,
    extensionUrl,

    /**
     * Opens one of the wallet's own pages (e.g. "index.html#/import") in a new tab. Wait for
     * something on it before using it: over BiDi, Firefox never reports a moz-extension://
     * navigation as finished, so there the navigation isn't awaited.
     */
    async openPage(p) {
      const page = await browser.newPage();
      const navigation = page.goto(extensionUrl(p));
      if (walletPrefix.startsWith("moz-extension://")) navigation.catch(() => {});
      else await navigation;
      return page;
    },

    /** Resolves with the next approval window the wallet opens, once it has rendered. */
    async waitForApprovalWindow({ timeout = 10_000 } = {}) {
      for (const end = Date.now() + timeout; ; await new Promise((r) => setTimeout(r, 100))) {
        const [page] = await liveApprovals();
        if (page) {
          await page.waitForSelector("[data-approval-ready]", { timeout });
          return page;
        }
        if (Date.now() > end) throw new Error(`No approval window within ${timeout} ms`);
      }
    },

    /** Approval windows open right now (to assert that none was opened). */
    approvalWindows: liveApprovals,

    close: () => closeBrowser(browser, profile),
  };
}

/** Closes the browser and deletes `profile` (pass undefined to keep it). */
async function closeBrowser(browser, profile) {
  await browser.close().catch(() => {});
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function withExtensionsPage(browser, fn) {
  const page = await browser.newPage();
  try {
    await page.goto("chrome://extensions");
    await page.waitForFunction(() => typeof chrome?.developerPrivate !== "undefined");
    return await fn(page);
  } finally {
    await page.close();
  }
}

/**
 * Serves the test Sidechain App (e2e/test-app) on 127.0.0.1, with the `client` library bundled in.
 * `url(host)` / `origin(host)` give the app under any `<name>.localhost` host, each its own origin.
 */
export async function serveTestApp() {
  const bundle = await esbuild.build({
    entryPoints: [path.join(here, "test-app", "app.js")],
    bundle: true,
    format: "esm",
    write: false,
  });
  const appJs = bundle.outputFiles[0].text;
  const html = await readFile(path.join(here, "test-app", "index.html"), "utf8");
  const server = createServer((request, response) => {
    if (request.url === "/app.js") {
      response.writeHead(200, { "Content-Type": "text/javascript" });
      response.end(appJs);
    } else {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: (host = "app.localhost") => `http://${host}:${port}/`,
    origin: (host = "app.localhost") => `http://${host}:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Starts the stub Standard Sidechain API server (see stub-server/README.md) on a free loopback
 * port. `config` is the stub's fixture table (`state`, `transfers`). Returns the stub plus its
 * `url`; `await close()`.
 */
export async function serveSidechainServer(config) {
  const entry = JSON.parse(await readFile(path.join(ROOT, "core", "elements", "chain-entry.json"), "utf8")).networks.betanet;
  const stub = createStubServer({ chain: entry.chain, ...config });
  return { ...stub, url: await stub.listen() };
}

/**
 * Starts the stub Esplora server where the e2e build's Slot 24 Chain Entry names betanet's server,
 * so one test file that uses it at a time. `config` (`identityBlock`, `utxos`) is read on every
 * request, so a test may change it. Returns the stub plus its `url`; `await close()`.
 */
export async function serveEsplora(config, server = E2E_SIDECHAIN_SERVER) {
  const url = new URL(server.url);
  const stub = createEsploraStub(config);
  await stub.listen(Number(url.port), url.hostname);
  return { ...stub, url: server.url };
}

/** `serveEsplora` where the e2e build's eCash Chain Entry names betanet's server (`E2E_L1_SERVER`). */
export const serveL1Esplora = (config) => serveEsplora(config, E2E_L1_SERVER);

/** `serveEsplora` in Flush mode where the e2e build's Flush Chain Entry names betanet's server (`E2E_FLUSH_SERVER`). */
export const serveFlushEsplora = (config) => serveEsplora(Object.assign(config, { flush: true }), E2E_FLUSH_SERVER);

/** The wallet's TypeScript (`wallet/`), bundled for node the way esbuild bundles it for the background. */
export async function importWallet() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "wallet", "src", "index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

/** Opens a wallet screen (a hash route of the app, e.g. `#/grants`) in a new tab, once rendered. */
export async function openWalletPage(session, route) {
  const page = await session.browser.newPage();
  // Over BiDi (Firefox) the navigation to a moz-extension:// page never reports completion, though
  // the page loads; so wait for the screen itself rather than for goto.
  page.goto(session.extensionUrl(`index.html${route}`)).catch(() => {});
  await page.waitForSelector("[data-screen-ready]");
  return page;
}

/** A Master Mnemonic whose Slot 24 Starter and address are fixed test vectors (see the core crates' tests). */
export const ABANDON = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const WALLET_PASSWORD = "correct horse battery";

/**
 * Imports `phrase` (no passphrase) under `password`, waits until the wallet is unlocked, and turns on
 * the sidechains in `on` (sidechains start off; most tests use Slot 24's).
 */
export async function setUpWallet(session, { phrase = ABANDON, password = WALLET_PASSWORD, on = [24] } = {}) {
  const page = await session.openPage("index.html#/import");
  await page.waitForSelector("[data-wallet-ready]", { timeout: 10_000 });
  await page.type("[data-import-phrase]", phrase);
  await page.type("[data-new-password]", password);
  await page.type("[data-repeat-password]", password);
  await page.click("[data-submit]");
  await page.waitForSelector('[data-vault-state="unlocked"]');
  await homeSettled(page);
  for (const slot of on) await turnOnChain(page, slot);
  await page.close();
}

/** Turns a sidechain on, as the Chains screen does, from any open wallet page. */
export async function turnOnChain(page, slot, on = true) {
  const answer = await page.evaluate((m) => chrome.runtime.sendMessage(m), { kind: "chains.setOn", slot, on });
  if (!answer.ok) throw new Error(answer.error.message);
}

/**
 * The approval a wallet page shows in place of itself (its own Send or Deposit: a window would
 * close the toolbar popup), once rendered. Returns `page`, to use as the approval window was.
 */
export async function approvalIn(page, { timeout = 10_000 } = {}) {
  await page.waitForSelector("[data-approval-ready]", { timeout });
  return page;
}

/**
 * Answers the approval `page` shows in place with `button` (`[data-approve]`, `[data-reject]`) and
 * waits until the page is back to its own screen, so closing it can't cut the answer off.
 */
export async function answerIn(page, button) {
  await page.click(button);
  await page.waitForFunction(() => document.querySelector("[data-approval-ready]") === null, { timeout: 10_000 });
}

/**
 * Waits until the home page's Activity tab has read its history: not refreshing, and showing
 * entries, "No transactions yet" or why it couldn't read them. Close the page only after, as with
 * `homeSettled` (which waits for the Home tab's cards, not shown here).
 */
export async function activitySettled(page) {
  await page.waitForSelector(
    "[data-activity]:not([data-refreshing]) :is([data-history-entry], [data-history-empty], [data-history-error])",
    { timeout: 20_000 },
  );
}

/**
 * Waits until the unlocked home page's requests have settled: a section for each chain that's on,
 * each with its fresh balance (not this session's last one, shown while refreshing) or why there
 * is none, and each Slot's with its Deposits. Close
 * the page only after: a reply to a closed page makes Firefox log, and each request derives a key,
 * which counts as Vault activity.
 */
export async function homeSettled(page) {
  await page.waitForFunction(
    () => {
      if (document.querySelector("[data-chains-ready]") === null) return false;
      const cards = [...document.querySelectorAll("[data-account]")];
      const settled = (card) =>
        !card.hasAttribute("data-refreshing") &&
        card.querySelector("[data-balance], [data-no-balance], [data-balance-error]") !== null &&
        (card.getAttribute("data-account") === "l1" || card.hasAttribute("data-deposits-ready"));
      return cards.length > 0 && cards.every(settled);
    },
    { timeout: 20_000 },
  );
}

/**
 * Locks the wallet from its home page and unlocks it again: the wallet forgets everything it kept
 * for the session (passed identity checks, last balances, raw transactions), as on any lock.
 */
export async function relock(session, password = WALLET_PASSWORD) {
  const page = await session.openPage("index.html#/");
  await page.waitForSelector('[data-vault-state="unlocked"]', { timeout: 10_000 });
  await homeSettled(page);
  await page.click("[data-lock]");
  await page.waitForSelector('[data-vault-state="locked"] [data-password]', { timeout: 10_000 });
  await page.type("[data-password]", password);
  await page.click("[data-unlock]");
  await page.waitForSelector('[data-vault-state="unlocked"]', { timeout: 10_000 });
  await homeSettled(page);
  await page.close();
}

/** Opens the test app in a new tab and waits until its script is ready. */
export async function openTestApp(session, app, host) {
  const page = await session.browser.newPage();
  await page.goto(app.url(host));
  await page.waitForFunction(() => window.testApp !== undefined);
  return page;
}
