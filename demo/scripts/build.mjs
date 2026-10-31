// Bundles the demo into dist/: index.html and main.js, a static site any host can serve.
import { copyFile, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);
await mkdir(dist, { recursive: true });
await esbuild.build({ entryPoints: [new URL("src/main.ts", root).pathname], bundle: true, format: "esm", target: "es2022", outfile: new URL("main.js", dist).pathname });
await copyFile(new URL("src/index.html", root), new URL("index.html", dist));
console.log(`demo: built ${dist.pathname}`);
