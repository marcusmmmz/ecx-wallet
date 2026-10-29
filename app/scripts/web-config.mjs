import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Elements (Slot 24): explorer.bitnames.info sends no CORS headers (checked 2026-10-29).
// Keep exclusions here, outside the Chain Entry file format, for both code and shipped assets.
const EXCLUDED_MODULES = ["elements"];
export const modules = ["l1", "elements", "flush"].filter((name) => !EXCLUDED_MODULES.includes(name));
export const chainEntries = modules.map((name) =>
  process.env.ECX_CHAIN_ENTRIES?.split(",").find((file) => file.endsWith(`/${name}-chain-entry.json`))
    ?? fileURLToPath(new URL(`../../core/${name}/chain-entry.json`, import.meta.url)));
export const moduleFiles = Object.fromEntries((await Promise.all(chainEntries.map(async (file, i) => {
  const entry = JSON.parse(await readFile(file, "utf8"));
  return entry.slot === undefined ? [] : [[entry.slot, `${modules[i]}.wasm`]];
}))).flat());

/** Select the registry in both Vite's page and Worker builds; no wallet API changes. */
export function webChains() {
  const registry = fileURLToPath(new URL("../../wallet/src/module-files.ts", import.meta.url));
  return {
    name: "web-chains",
    transform(_code, id) {
      if (id === registry) return `export const CHAIN_MODULE_FILES = ${JSON.stringify(moduleFiles)};`;
    },
  };
}
