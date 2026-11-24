import { nativeFiles } from "./scripts/native-files";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import process from "node:process";

import { build, type OnLoadResult, type OnResolveResult, type Plugin, type PluginBuild } from "esbuild";

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

// Read manuscript titles outside a live editor. Keep the website's parser in its
// own module: Obsidian's older StreamLanguage requires a viewport for nested TeX.
const chapterInspection = await build({
  entryPoints: ["../editor/chapter-title.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  plugins: [bananaMark],
  write: false,
  metafile: Boolean(inputInventory),
});

const standaloneInspection: Plugin = {
  name: "standalone-chapter-inspection",
  setup(plugin: PluginBuild): void {
    plugin.onLoad({filter:/\/editor\/chapter-title\.js$/}, (): OnLoadResult =>
      ({contents:chapterInspection.outputFiles[0].text, loader:"js"}));
  },
};

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
  plugins: [bananaMark, standaloneInspection],
  define: { __PEERPEDIA_ANCHORED__: JSON.stringify(nativeFiles()), __PEERPEDIA_LANGUAGE_WORKER__: JSON.stringify(worker.outputFiles[0].text) },
  external: [
    "obsidian", "electron", ...builtinModules,
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language",
    "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
  ],
});

if (inputInventory && worker.metafile && chapterInspection.metafile && plugin.metafile) {
  await writeFile(inputInventory, JSON.stringify([...Object.keys(worker.metafile.inputs), ...Object.keys(chapterInspection.metafile.inputs), ...Object.keys(plugin.metafile.inputs)]));
}

// Build once from the website-owned theme; ship only the scoped editor rules here.
execFileSync(process.execPath, ["../packages/peerpedia-theme/scripts/build.mjs"]);
await writeFile(join(dirname(outputFile), "styles.css"),
  await readFile("styles.css", "utf8") + "\n" + await readFile("../packages/peerpedia-theme/dist/syntax.css", "utf8"));
