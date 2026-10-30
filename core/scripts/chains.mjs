// The network a build serves and the Chain Modules it bundles (docs/adr/0019): every module whose
// Chain Entry names that network. The shipped build is mainnet; the e2e build sets
// $ECX_NETWORK=betanet. $ECX_CHAIN_ENTRIES (comma-separated) replaces the shipped Chain Entries
// with the e2e build's.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const NETWORK = process.env.ECX_NETWORK ?? "mainnet";

/** Every Chain Module, by its directory in core/ and its .wasm's name. */
export const CHAIN_MODULES = ["l1", "elements", "flush"];

/** The Chain Entry file the build reads for `name`. */
export function chainEntryFile(name) {
  return process.env.ECX_CHAIN_ENTRIES?.split(",").find((file) => file.endsWith(`/${name}-chain-entry.json`))
    ?? fileURLToPath(new URL(`../${name}/chain-entry.json`, import.meta.url));
}

/** The modules among `names` whose Chain Entry names `NETWORK`: name, Chain Entry file and that network's entry. */
export async function bundledChains(names = CHAIN_MODULES) {
  const chains = await Promise.all(names.map(async (name) => {
    const file = chainEntryFile(name);
    const network = JSON.parse(await readFile(file, "utf8")).networks[NETWORK];
    return network && { name, file, network };
  }));
  return chains.filter(Boolean);
}

/** wallet/src/module-files.ts for these chains: each sidechain's Slot on `NETWORK` and its .wasm. */
export function moduleFilesSource(chains) {
  const files = Object.fromEntries(chains.filter((c) => c.network.slot !== undefined).map((c) => [c.network.slot, `${c.name}.wasm`]));
  return `export const CHAIN_MODULE_FILES = ${JSON.stringify(files)};`;
}

/** The sidechain servers' origins on `NETWORK`: what the build lets the wallet reach. */
export function sidechainServerOrigins(chains) {
  return [...new Set(chains.map((c) => new URL(c.network.sidechainServer.url).origin))].sort();
}
