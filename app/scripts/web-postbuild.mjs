import { cp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chains, modules } from "./web-config.mjs";
import { sidechainServerOrigins } from "../../core/scripts/chains.mjs";
import { checkNoEval } from "../../extension/scripts/check-no-eval.mjs";

const output = new URL(`${process.env.ECX_APP_WEB_DIST ?? "build-web"}/`, new URL("../", import.meta.url));
const core = new URL(`${process.env.ECX_CORE_DIST ?? "../core/dist"}/`, new URL("../", import.meta.url));
for (const name of ["vault", ...modules]) {
  await cp(new URL(`${name}.wasm`, core), new URL(`${name}.wasm`, output));
}
const origins = sidechainServerOrigins(chains);
// Svelte writes style attributes; checked asset logos are data: images. Neither needs script access.
const csp = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'",
  `connect-src 'self' ${origins.join(" ")}`, "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'",
].join("; ");
const headers = { "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
// The same headers for Netlify / Cloudflare Pages (`_headers`) and Vercel (`vercel.json`).
await writeFile(new URL("_headers", output), `/*\n${Object.entries(headers).map(([name, value]) => `  ${name}: ${value}\n`).join("")}`);
await writeFile(new URL("vercel.json", output), `${JSON.stringify({
  headers: [{ source: "/(.*)", headers: Object.entries(headers).map(([key, value]) => ({ key, value })) }],
}, null, 2)}\n`);
await checkNoEval(fileURLToPath(output));
console.log(`web: built ${fileURLToPath(output)}`);
