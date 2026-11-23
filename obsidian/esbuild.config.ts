import { builtinModules, createRequire } from "node:module";
import process from "node:process";

import { build, type OnResolveResult, type PluginBuild } from "esbuild";

const production = process.argv[2] === "production";
const require = createRequire(import.meta.url);

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: production ? false : "inline",
  minify: production,
  plugins: [{
    name: "bundled-bananamark",
    setup(plugin: PluginBuild): void {
      // The website's title inspector and plugin code use this build's parser.
      plugin.onResolve({ filter: /^bananamark$/ }, (): OnResolveResult => ({ path: require.resolve("bananamark") }));
    },
  }],
  external: [
    "obsidian", "electron", ...builtinModules,
    "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands", "@codemirror/language",
    "@codemirror/lint", "@codemirror/search", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "@lezer/highlight", "@lezer/lr",
  ],
});
