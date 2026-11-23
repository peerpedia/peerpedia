import { builtinModules, createRequire } from "node:module";
import process from "node:process";

import { build, type OnResolveResult, type Plugin, type PluginBuild } from "esbuild";

const production = process.argv[2] === "production";
const require = createRequire(import.meta.url);

const bananaMark: Plugin = {
  name: "bundled-bananamark",
  setup(plugin: PluginBuild): void {
    plugin.onResolve({ filter: /^bananamark$/ }, (): OnResolveResult => ({ path: require.resolve("bananamark") }));
  },
};

// Embed the independently bundled worker in the standard single-file plugin.
const worker = await build({
  entryPoints: ["src/language/worker.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: production,
  plugins: [bananaMark],
  write: false,
});

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: production ? false : "inline",
  minify: production,
  plugins: [bananaMark],
  define: { __PEERPEDIA_LANGUAGE_WORKER__: JSON.stringify(worker.outputFiles[0].text) },
  external: [
    "obsidian", "electron", ...builtinModules,
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language",
    "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
  ],
});
