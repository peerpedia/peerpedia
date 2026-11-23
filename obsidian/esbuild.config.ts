import { builtinModules } from "node:module";
import process from "node:process";

import { build } from "esbuild";

const production = process.argv[2] === "production";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: production ? false : "inline",
  minify: production,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
});
