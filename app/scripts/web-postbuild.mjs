import { cp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { modules, chainEntries } from "./web-config.mjs";
import { sidechainServerOrigins } from "../../extension/scripts/chain-origins.mjs";
import { checkNoEval } from "../../extension/scripts/check-no-eval.mjs";

const output = new URL("../build-web/", import.meta.url);
for (const name of ["vault", ...modules]) {
  await cp(new URL(`../../core/dist/${name}.wasm`, import.meta.url), new URL(`${name}.wasm`, output));
}
const origins = await sidechainServerOrigins(chainEntries);
// Svelte writes style attributes; checked asset logos are data: images. Neither needs script access.
const csp = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'",
  `connect-src 'self' ${origins.join(" ")}`, "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");
await writeFile(new URL("_headers", output), `/*\n  Content-Security-Policy: ${csp}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`);
await checkNoEval(fileURLToPath(output));
console.log(`web: built ${fileURLToPath(output)}`);
