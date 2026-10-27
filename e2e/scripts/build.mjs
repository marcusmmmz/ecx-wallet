// The e2e build: the shipped extension with one change, each Chain Entry's betanet Sidechain
// Server, which points at a stub Esplora server on loopback (`E2E_SERVERS`). Everything else comes
// from the same sources, so build-output.test can check the two builds differ only there.
//
//   e2e/dist/<module>-chain-entry.json   the shipped Chain Entry with the stub as betanet's server
//   e2e/dist/core/                        core modules; l1.wasm, elements.wasm and flush.wasm embed those
//   e2e/dist/extension/chromium/, firefox/
//
// Run after the shipped build (it reuses the app build): the root `pnpm test` does.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Slot 24's betanet Sidechain Server in the e2e build: harness.mjs serves the Esplora stub here. */
export const E2E_SIDECHAIN_SERVER = { api: "esplora", url: "http://127.0.0.1:24024" };
/** eCash betanet's server in the e2e build: another Esplora stub, on its own port. */
export const E2E_L1_SERVER = { api: "esplora", url: "http://127.0.0.1:24000" };
/** Flush's (Slot 99) betanet server in the e2e build: the Esplora stub in Flush mode, on its own port. */
export const E2E_FLUSH_SERVER = { api: "flush", url: "http://127.0.0.1:24046" };

/** Per module: its Chain Entry's env var for `core/<module>/build.rs`, its .wasm and its e2e server. */
export const E2E_SERVERS = {
  l1: { env: "ECX_L1_CHAIN_ENTRY", wasm: "l1.wasm", server: E2E_L1_SERVER },
  elements: { env: "ECX_ELEMENTS_CHAIN_ENTRY", wasm: "elements.wasm", server: E2E_SIDECHAIN_SERVER },
  flush: { env: "ECX_FLUSH_CHAIN_ENTRY", wasm: "flush.wasm", server: E2E_FLUSH_SERVER },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "e2e", "dist");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(out, { recursive: true });
  const coreEnv = {};
  const entries = [];
  for (const [module, { env, server }] of Object.entries(E2E_SERVERS)) {
    const entry = JSON.parse(await readFile(path.join(root, "core", module, "chain-entry.json"), "utf8"));
    entry.networks.betanet.sidechainServer = server;
    const file = path.join(out, `${module}-chain-entry.json`);
    await writeFile(file, `${JSON.stringify(entry, null, 2)}\n`);
    coreEnv[env] = file;
    entries.push(file);
  }

  const run = (dir, env) =>
    execFileSync("node", ["scripts/build.mjs"], { cwd: path.join(root, dir), stdio: "inherit", env: { ...process.env, ...env } });
  const coreDist = path.join(out, "core");
  // Its own cargo target dir, so the shipped and e2e builds don't keep rebuilding each other.
  run("core", { ...coreEnv, ECX_CORE_DIST: coreDist, CARGO_TARGET_DIR: path.join(root, "core", "target", "e2e") });
  run("extension", { ECX_CORE_DIST: coreDist, ECX_CHAIN_ENTRIES: entries.join(","), ECX_EXTENSION_DIST: path.join(out, "extension") });
}
