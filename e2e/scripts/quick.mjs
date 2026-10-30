// `pnpm test:quick <name>...`: build, then run only the named e2e files, in Brave. For the day to
// day loop; the full `pnpm test`, in both browsers, stays the check before a push or merge.
//
//   pnpm test:quick vault chains   runs e2e/tests/vault.test.mjs and e2e/tests/chains.test.mjs
//
// Names are checked before building, so a typo fails at once.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_NETWORK } from "./build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const e2e = path.join(root, "e2e");
const known = readdirSync(path.join(e2e, "tests"))
  .filter((file) => file.endsWith(".test.mjs"))
  .map((file) => file.slice(0, -".test.mjs".length));

// Also accept `vault.test.mjs` or `tests/vault.test.mjs`, as a shell completion would give them.
const names = process.argv.slice(2).map((arg) => path.basename(arg).replace(/\.test\.mjs$/, ""));
const unknown = names.filter((name) => !known.includes(name));
if (names.length === 0 || unknown.length > 0) {
  if (unknown.length > 0) console.error(`Unknown e2e file: ${unknown.join(", ")}`);
  console.error(`Usage: pnpm test:quick <name>...\nNames: ${known.join(" ")}`);
  process.exit(2);
}

function run(command, args, options = {}) {
  const { status, error } = spawnSync(command, args, { stdio: "inherit", ...options });
  if (error) console.error(error.message);
  // `status` is null when the child was killed or never started.
  if (status !== 0) process.exit(status ?? 1);
}

run("pnpm", ["build"], { cwd: root });
run("pnpm", ["build:e2e"], { cwd: root });
// The web tests serve the web build, which reuses build:e2e's stub-backed core.
if (names.includes("web-wallet")) run("pnpm", ["build:e2e:web"], { cwd: root });
// The flags and $ECX_NETWORK match @ecx/e2e's `test` script: --test-concurrency=1, or the pull-path tests hang.
run(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-timeout=120000", ...names.map((name) => `tests/${name}.test.mjs`)],
  { cwd: e2e, env: { ...process.env, E2E_BROWSERS: "brave", ECX_NETWORK: E2E_NETWORK } },
);
