import { nativeFiles } from "./scripts/native-files";
import { writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import process from "node:process";

import { build, type OnResolveResult, type Plugin, type PluginBuild } from "esbuild";

const [, , mode, outputFile = "dist/main.js", inputInventory] = process.argv;
const production = mode === "production";
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
  metafile: Boolean(inputInventory),
});

const plugin = await build({
  entryPoints: ["src/main.ts"],
  outfile: outputFile,
  metafile: Boolean(inputInventory),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: production ? false : "inline",
  minify: production,
  plugins: [bananaMark],
  define: { __PEERPEDIA_ANCHORED__: JSON.stringify(nativeFiles()), __PEERPEDIA_LANGUAGE_WORKER__: JSON.stringify(worker.outputFiles[0].text) },
  external: [
    "obsidian", "electron", ...builtinModules,
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language",
    "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
  ],
});

if (inputInventory && worker.metafile && plugin.metafile) {
  await writeFile(inputInventory, JSON.stringify([...Object.keys(worker.metafile.inputs), ...Object.keys(plugin.metafile.inputs)]));
}
