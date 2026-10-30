// What ships: both browser builds, checked as files (no browser needed), and the e2e build,
// checked to differ from them only in the network they serve (mainnet ships, the e2e build is
// betanet's: core/scripts/chains.mjs) and the Chain Entries' Sidechain Servers.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { DIST, DIST_E2E, importWallet } from "../harness.mjs";
import { E2E_NETWORK, E2E_SERVERS } from "../scripts/build.mjs";

const EXPECTED_SCRIPT_SRC = ["'self'", "'wasm-unsafe-eval'"];

async function files(dir) {
  return (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)))
    .sort();
}

test("Chromium and Firefox builds ship identical files apart from manifest.json", async () => {
  const chromium = (await files(DIST.chromium)).filter((f) => f !== "manifest.json");
  const firefox = (await files(DIST.firefox)).filter((f) => f !== "manifest.json");
  assert.deepEqual(firefox, chromium);
  for (const f of chromium) {
    const [a, b] = await Promise.all([readFile(path.join(DIST.chromium, f)), readFile(path.join(DIST.firefox, f))]);
    assert.ok(a.equals(b), `${f} differs between builds`);
  }
});

for (const [target, dir] of Object.entries(DIST)) {
  test(`${target}: manifest CSP allows 'wasm-unsafe-eval' and nothing looser`, async () => {
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    const directives = Object.fromEntries(
      manifest.content_security_policy.extension_pages
        .split(";")
        .map((d) => d.trim().split(/\s+/))
        .filter((d) => d[0])
        .map(([name, ...values]) => [name, values]),
    );
    assert.deepEqual(directives["script-src"], EXPECTED_SCRIPT_SRC);
    assert.deepEqual(directives["object-src"], ["'none'"]);
    assert.equal(directives["default-src"], undefined, "default-src would widen script-src fallbacks");
  });

  test(`${target}: built pages contain no inline scripts or inline event handlers`, async () => {
    for (const f of (await files(dir)).filter((f) => f.endsWith(".html"))) {
      const html = await readFile(path.join(dir, f), "utf8");
      for (const [, attrs] of html.matchAll(/<script\b([^>]*)>/g)) {
        assert.match(attrs, /\bsrc=/, `${f} has an inline <script>`);
      }
      assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${f} has an inline event handler`);
    }
  });
}

/** The CSP's `connect-src`, and the manifest without it or `host_permissions`. */
function splitManifest(manifest) {
  const { host_permissions: hostPermissions, ...rest } = manifest;
  const directives = rest.content_security_policy.extension_pages.split(";").map((d) => d.trim());
  const connectSrc = directives.find((d) => d.startsWith("connect-src"));
  const csp = { ...rest.content_security_policy, extension_pages: directives.filter((d) => d !== connectSrc).join("; ") };
  return { hostPermissions, connectSrc, rest: { ...rest, content_security_policy: csp } };
}

for (const target of Object.keys(DIST)) {
  test(`${target}: the shipped build reaches eCash's and Flush's mainnet servers, and nothing else`, async () => {
    const { hostPermissions, connectSrc } = splitManifest(JSON.parse(await readFile(path.join(DIST[target], "manifest.json"), "utf8")));
    const servers = ["https://explorer.blockfab.org", "https://explorer.ecash.ninja"];
    assert.deepEqual(hostPermissions, servers.map((s) => `${s}/*`));
    assert.equal(connectSrc, `connect-src 'self' ${servers.join(" ")}`);
  });

  test(`${target}: the e2e build differs from the shipped build only in its network and Sidechain Servers`, async () => {
    const modules = Object.values(E2E_SERVERS);
    const shipped = await files(DIST[target]);
    // Elements+ has no mainnet network, so only the betanet build carries it.
    assert.deepEqual(await files(DIST_E2E[target]), [...shipped, "elements.wasm"].sort());
    // The background names each build's Chain Modules (wallet/src/module-files.ts).
    const moduleFiles = (js) => js.replace(/CHAIN_MODULE_FILES = \{[^}]*\}/, "CHAIN_MODULE_FILES = {}");
    for (const f of shipped.filter((f) => f !== "manifest.json" && !modules.some((m) => m.wasm === f))) {
      const [a, b] = await Promise.all([readFile(path.join(DIST[target], f)), readFile(path.join(DIST_E2E[target], f))]);
      const same = a.equals(b) || (f === "background.js" && moduleFiles(a.toString()) === moduleFiles(b.toString()));
      assert.ok(same, `${f} differs between the shipped and e2e builds`);
    }

    // The manifest: only the servers' origins.
    const [ours, e2e] = await Promise.all(
      [DIST, DIST_E2E].map(async (d) => splitManifest(JSON.parse(await readFile(path.join(d[target], "manifest.json"), "utf8")))),
    );
    assert.deepEqual(e2e.rest, ours.rest);
    const origins = modules.map((m) => new URL(m.server.url).origin).sort();
    assert.deepEqual(e2e.hostPermissions, origins.map((o) => `${o}/*`));
    assert.equal(e2e.connectSrc, `connect-src 'self' ${origins.join(" ")}`);

    // Each module both ship: each serving its build's network, embedding a Chain Entry that
    // differs only in betanet's server.
    const { loadChainModule } = await importWallet();
    for (const { wasm, server } of modules.filter((m) => shipped.includes(m.wasm))) {
      const [shippedModule, e2eModule] = await Promise.all(
        [DIST, DIST_E2E].map(async (d) => loadChainModule(await readFile(path.join(d[target], wasm)))),
      );
      const entry = e2eModule.chainEntry();
      assert.equal(shippedModule.declare().binding.chain, entry.networks.mainnet.chain, wasm);
      assert.equal(e2eModule.declare().binding.chain, entry.networks[E2E_NETWORK].chain, wasm);
      assert.deepEqual(entry.networks[E2E_NETWORK].sidechainServer, server, wasm);
      entry.networks[E2E_NETWORK].sidechainServer = shippedModule.chainEntry().networks[E2E_NETWORK].sidechainServer;
      assert.deepEqual(entry, shippedModule.chainEntry(), wasm);
    }
  });
}
