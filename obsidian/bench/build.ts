import { build, type PluginBuild, type OnResolveResult } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildBrowserRenderer } from "../../packages/peerpedia-renderer/build-browser";
const base = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const worker = await buildBrowserRenderer(
  resolve(base, "../renderer/browser.ts"),
);
await build({
  entryPoints: [resolve(base, "entry.ts")],
  outfile: resolve(base, "../dist/benchmark.js"),
  bundle: true,
  format: "iife",
  platform: "node",
  target: "es2022",
  // Match the production build: alias the package entry, never its subpaths.
  plugins: [
    {
      name: "shared-bananamark",
      setup(plugin: PluginBuild): void {
        plugin.onResolve({ filter: /^bananamark$/ }, (): OnResolveResult => ({
          path: require.resolve("bananamark"),
        }));
      },
    },
  ],
  external: ["obsidian"],
  define: { __PEERPEDIA_RENDERER_WORKER__: JSON.stringify(worker.source) },
});
