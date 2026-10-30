// Builds every core module to its own `.wasm` in core/dist/, reproducibly, and fails unless each
// one imports nothing but memory.
//
//   node scripts/build.mjs
//
// It builds for $ECX_NETWORK (mainnet unless set), and only the Chain Modules whose Chain Entry
// names that network (scripts/chains.mjs). The e2e build (e2e/scripts/build.mjs) sets $ECX_ELEMENTS_CHAIN_ENTRY, $ECX_L1_CHAIN_ENTRY and
// $ECX_FLUSH_CHAIN_ENTRY (the Chain Entries the Chain Modules embed), $ECX_CORE_DIST (instead of core/dist/) and
// $CARGO_TARGET_DIR.
//
// Needs the pinned Rust toolchain (rust-toolchain.toml; rustup installs it) with the
// wasm32-unknown-unknown target, and a clang with the WebAssembly backend plus llvm-ar for
// libsecp256k1's C code (override with $CC_wasm32_unknown_unknown / $AR_wasm32_unknown_unknown;
// on macOS point them at Homebrew LLVM). wasm-opt comes pinned from npm (binaryen).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledChains, NETWORK } from "./chains.mjs";
import { checkWasmImports } from "./check-wasm-imports.mjs";

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = process.env.ECX_CORE_DIST ?? path.join(core, "dist");
const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(core, "target");
const TARGET = "wasm32-unknown-unknown";

/** One entry per module: the C-ABI crate and the file it ships as. A Chain Module ships only on the networks its Chain Entry names. */
const bundled = new Set((await bundledChains()).map((c) => `${c.name}.wasm`));
export const MODULES = [
  { crate: "ecx-vault-wasm", file: "vault.wasm" },
  { crate: "ecx-elements-wasm", file: "elements.wasm" },
  { crate: "ecx-l1-wasm", file: "l1.wasm" },
  { crate: "ecx-flush-wasm", file: "flush.wasm" },
].filter(({ file }) => file === "vault.wasm" || bundled.has(file));

const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: core, stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, ...env } })
    .toString()
    .trim();

// Keep build-machine paths out of the binaries (panic locations embed source paths), so the
// bytes don't depend on where the repo or the cargo/rustup homes live.
const cargoHome = process.env.CARGO_HOME ?? path.join(homedir(), ".cargo");
const sysroot = run("rustc", ["--print", "sysroot"]);
const rustflags = [
  `--remap-path-prefix=${core}=/ecx/core`,
  `--remap-path-prefix=${cargoHome}=/cargo`,
  `--remap-path-prefix=${sysroot}=/rustc`,
];

const env = {
  CC_wasm32_unknown_unknown: process.env.CC_wasm32_unknown_unknown ?? "clang",
  AR_wasm32_unknown_unknown: process.env.AR_wasm32_unknown_unknown ?? "llvm-ar",
  CARGO_INCREMENTAL: "0",
  SOURCE_DATE_EPOCH: "946684800",
  CARGO_ENCODED_RUSTFLAGS: rustflags.join("\x1f"),
  ECX_NETWORK: NETWORK,
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const wasmOpt = path.join(core, "node_modules", "binaryen", "bin", "wasm-opt");

for (const { crate, file } of MODULES) {
  run("cargo", ["build", "--locked", "--release", "--target", TARGET, "-p", crate], env);
  const raw = path.join(targetDir, TARGET, "release", `${crate.replaceAll("-", "_")}.wasm`);
  const out = path.join(dist, file);
  // rustc emits bulk-memory and friends; wasm-opt rejects them unless enabled explicitly.
  run(process.execPath, [
    wasmOpt, "-Oz",
    "--enable-bulk-memory", "--enable-nontrapping-float-to-int", "--enable-sign-ext",
    "--enable-mutable-globals", "--enable-reference-types", "--enable-multivalue",
    raw, "-o", out,
  ]);
  const bytes = await readFile(out);
  checkWasmImports(file, bytes);
  console.log(`core: ${file} (${NETWORK}) ${bytes.length} B sha256 ${createHash("sha256").update(bytes).digest("hex")}`);
}
