import { fileURLToPath } from "node:url";
import { bundledChains, moduleFilesSource } from "../../core/scripts/chains.mjs";

// Elements (Slot 24): explorer.bitnames.info sends no CORS headers (checked 2026-10-29).
// Keep exclusions here, outside the Chain Entry file format, for both code and shipped assets.
const EXCLUDED_MODULES = ["elements"];
/** The build network's chains (core/scripts/chains.mjs), less those the web build can't reach. */
export const chains = (await bundledChains()).filter((c) => !EXCLUDED_MODULES.includes(c.name));
export const modules = chains.map((c) => c.name);

/** Select the registry in both Vite's page and Worker builds; no wallet API changes. */
export function webChains() {
  const registry = fileURLToPath(new URL("../../wallet/src/module-files.ts", import.meta.url));
  return {
    name: "web-chains",
    transform(_code, id) {
      if (id === registry) return moduleFilesSource(chains);
    },
  };
}
