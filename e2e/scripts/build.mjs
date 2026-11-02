// The e2e build: the extension for betanet (`E2E_NETWORK`; the shipped build is mainnet's), with
// each Chain Entry's betanet Sidechain Server pointed at a stub Esplora server on loopback
// (`E2E_SERVERS`). Everything else comes from the same sources.
//
//   e2e/dist/<module>-chain-entry.json   the shipped Chain Entry with the stub as betanet's server
//   e2e/dist/core/                        core modules; l1.wasm, elements.wasm and flush.wasm embed those
//   e2e/dist/extension/chromium/, firefox/
//
// `--network mainnet` (`pnpm build:e2e:mainnet`) builds the same for mainnet into e2e/dist/mainnet/,
// mainnet's servers pointed at the same stubs: the shipped build's network, on servers tests
// control (mainnet.test). Elements+ has no mainnet, so that build has no elements.wasm.
//
// Run after the shipped build (it reuses the app build): the root `pnpm test` does.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The network the e2e build and its tests serve: betanet, which every fixture is of. */
export const E2E_NETWORK = "betanet";

/** Slot 24's betanet Sidechain Server in the e2e build: harness.mjs serves the Esplora stub here. */
export const E2E_SIDECHAIN_SERVER = { api: "esplora", url: "http://127.0.0.1:24024" };
/** eCash's server in the e2e builds: another Esplora stub, on its own port. */
export const E2E_L1_SERVER = { api: "esplora", url: "http://127.0.0.1:24000" };
/** Flush's server in the e2e builds (Slot 99 on betanet, 46 on mainnet): the Esplora stub in Flush mode, on its own port. */
export const E2E_FLUSH_SERVER = { api: "flush", url: "http://127.0.0.1:24046" };

/** Per module: its Chain Entry's env var for `core/<module>/build.rs`, its .wasm and its e2e server. */
export const E2E_SERVERS = {
  l1: { env: "ECX_L1_CHAIN_ENTRY", wasm: "l1.wasm", server: E2E_L1_SERVER },
  elements: { env: "ECX_ELEMENTS_CHAIN_ENTRY", wasm: "elements.wasm", server: E2E_SIDECHAIN_SERVER },
  flush: { env: "ECX_FLUSH_CHAIN_ENTRY", wasm: "flush.wasm", server: E2E_FLUSH_SERVER },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Each network's e2e build: betanet's, which most tests use, and mainnet's (`--network mainnet`). */
export const E2E_DIST = {
  betanet: path.join(root, "e2e", "dist"),
  mainnet: path.join(root, "e2e", "dist", "mainnet"),
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const flag = process.argv.indexOf("--network");
  const network = flag === -1 ? E2E_NETWORK : process.argv[flag + 1];
  const out = E2E_DIST[network];
  if (!out) throw new Error(`No e2e build for network ${network}`);
  await mkdir(out, { recursive: true });
  const coreEnv = {};
  const entries = [];
  for (const [module, { env, server }] of Object.entries(E2E_SERVERS)) {
    const entry = JSON.parse(await readFile(path.join(root, "core", module, "chain-entry.json"), "utf8"));
    // A chain with no entry on this network isn't bundled (core/scripts/chains.mjs).
    if (!entry.networks[network]) continue;
    entry.networks[network].sidechainServer = server;
    const file = path.join(out, `${module}-chain-entry.json`);
    await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`);
    coreEnv[env] = file;
    entries.push(file);
  }

  const run = (dir, env) =>
    execFileSync("node", ["scripts/build.mjs"], { cwd: path.join(root, dir), stdio: "inherit", env: { ...process.env, ECX_NETWORK: network, ...env } });
  const coreDist = path.join(out, "core");
  // Its own cargo target dir, so the shipped and e2e builds don't keep rebuilding each other.
  const target = network === E2E_NETWORK ? "e2e" : `e2e-${network}`;
  run("core", { ...coreEnv, ECX_CORE_DIST: coreDist, CARGO_TARGET_DIR: path.join(root, "core", "target", target) });
  run("extension", { ECX_CORE_DIST: coreDist, ECX_CHAIN_ENTRIES: entries.join(","), ECX_EXTENSION_DIST: path.join(out, "extension") });
}
