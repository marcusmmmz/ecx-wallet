// Kept separate so a host build can select its bundled chains without changing wallet interfaces.
export const CHAIN_MODULE_FILES: Readonly<Record<number, string>> = { 24: "elements.wasm", 99: "flush.wasm" };
