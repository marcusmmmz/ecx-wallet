import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { webChains } from "./scripts/web-config.mjs";

export default defineConfig(({ mode }) => {
  const web = mode === "web";
  // svelte.config.js is also read by the adapter, in this same build process.
  process.env.ECX_APP_WEB = web ? "1" : "0";
  return {
    plugins: [sveltekit(), ...(web ? [webChains()] : [])],
    worker: { format: "es", plugins: () => web ? [webChains()] : [] },
    build: {
      // Inline data: URLs for small assets would need a looser CSP; keep everything in files.
      assetsInlineLimit: 0,
    },
  };
});
