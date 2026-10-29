// Reuse build:e2e's stub-backed core; keep the shipped web output separate.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_SERVERS } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = path.join(root, "e2e", "dist");
execFileSync("pnpm", ["--filter", "@ecx/app", "build:web"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ECX_CORE_DIST: path.join(out, "core"),
    ECX_CHAIN_ENTRIES: Object.keys(E2E_SERVERS).map((name) => path.join(out, `${name}-chain-entry.json`)).join(","),
    ECX_APP_WEB_DIST: path.join(out, "web"),
  },
});
