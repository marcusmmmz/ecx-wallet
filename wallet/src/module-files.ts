// Kept separate so a host build can select its bundled chains without changing wallet interfaces:
// each build replaces this betanet default with its network's (core/scripts/chains.mjs).
export const CHAIN_MODULE_FILES: Readonly<Record<number, string>> = { 24: "elements.wasm", 99: "flush.wasm" };
