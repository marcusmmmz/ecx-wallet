import adapter from "@sveltejs/adapter-static";

const output = process.env.ECX_APP_WEB === "1" ? "build-web" : "build";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    alias: { $platform: `./src/lib/platform/${process.env.ECX_APP_WEB === "1" ? "web" : "extension"}.ts` },
    // One static shell (index.html); every screen is a hash route, e.g. index.html#/approve/<id>.
    adapter: adapter({ pages: output, assets: output, fallback: undefined, strict: true }),
    router: { type: "hash" },
    // Chrome refuses to load extension files or directories whose name starts with "_".
    appDir: "kit",
    paths: { relative: true },
  },
};
