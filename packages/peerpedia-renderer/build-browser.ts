import { build, type PluginBuild, type OnResolveResult } from "esbuild";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const base = dirname(fileURLToPath(import.meta.url));
const root = resolve(base, "../..");
const upstream = join(base, "node_modules");
const require = createRequire(join(base, "package.json"));
/** Gzip's OS byte must not make otherwise identical release bundles differ. */
export function portableGzip(source: string | Uint8Array): Buffer {
  const bytes = gzipSync(source, { level: 9 });
  bytes[9] = 255;
  return bytes;
}

/** Keep engine bytes binary through compression; only the small index is JSON. */
export function encodeAssets(
  core: Uint8Array,
  wasm: Uint8Array,
  files: Record<string, Uint8Array>,
): string {
  const coreOffsets: number[] = [];
  const blocks: Uint8Array[] = [];
  for (let offset = 0; offset < core.byteLength; offset += 65536) {
    const block = core.subarray(offset, offset + 65536);
    if (block.some((value: number): boolean => value !== 0)) {
      coreOffsets.push(offset);
      blocks.push(block);
    }
  }
  const entries: [string, Uint8Array][] = [
    ["core", Buffer.concat(blocks)],
    ["wasm", wasm],
    ...Object.entries(files),
  ];
  const index = Buffer.from(
    JSON.stringify({
      coreLength: core.byteLength,
      coreOffsets,
      entries: entries.map(
        ([name, bytes]: [string, Uint8Array]): [string, number] => [
          name,
          bytes.byteLength,
        ],
      ),
    }),
  );
  const size = Buffer.alloc(4);
  size.writeUInt32LE(index.byteLength);
  return portableGzip(
    Buffer.concat([
      size,
      index,
      ...entries.map((entry: [string, Uint8Array]): Uint8Array => entry[1]),
    ]),
  ).toString("base64");
}

export async function buildBrowserRenderer(
  entry: string,
): Promise<{ source: string; inputs: Record<string, string> }> {
  const inputs: Record<string, string> = {};
  async function source(path: string): Promise<string> {
    const text = await readFile(path, "utf8");
    inputs[path.slice(root.length + 1)] = createHash("sha256")
      .update(text)
      .digest("hex");
    return text;
  }
  interface MemoryFiles {
    readdirSync(path: string): string[];
    statSync(path: string): { isDirectory(): boolean };
    readFileSync(path: string): Buffer;
  }
  const engine = require("node-tikzjax") as {
    load(): Promise<void>;
    dumpMemfs(): MemoryFiles;
    setAssetLoader?: unknown;
  };
  if (typeof engine.setAssetLoader !== "function")
    throw new Error(
      "Run npm run prepare:browser in packages/peerpedia-renderer before building.",
    );
  await engine.load();
  const fs = engine.dumpMemfs();
  const files: Record<string, Uint8Array> = {};
  function collect(path: string): void {
    for (const name of fs.readdirSync(path).sort()) {
      const file = path.replace(/\/$/, "") + "/" + name;
      if (fs.statSync(file).isDirectory()) collect(file);
      else files[file] = fs.readFileSync(file);
    }
  }
  collect("/");
  const texAssets = encodeAssets(
    gunzipSync(await readFile(join(upstream, "node-tikzjax/tex/core.dump.gz"))),
    gunzipSync(await readFile(join(upstream, "node-tikzjax/tex/tex.wasm.gz"))),
    files,
  );
  const recipe = {
    "/bananamark-tikz/compiler.mjs": await source(
      join(upstream, "bananamark-tikz/src/compiler.mjs"),
    ),
    "/bananamark-tikz/worker.mjs": await source(
      join(upstream, "bananamark-tikz/src/worker.mjs"),
    ),
    "/node-tikzjax/package.json": await source(
      join(upstream, "node-tikzjax/package.json"),
    ),
  };
  const aliases: Record<string, string> = {
    "node:crypto": join(base, "browser/crypto.ts"),
    crypto: join(base, "browser/crypto.ts"),
    jsdom: join(base, "browser/dom.ts"),
    svgo: join(base, "browser/empty.ts"),
    "node:worker_threads": join(base, "browser/threads.ts"),
    buffer: join(base, "node_modules/buffer/index.js"),
  };
  for (const key of [
    "fs",
    "node:fs",
    "node:fs/promises",
    "node:module",
    "path",
    "node:path",
  ])
    aliases[key] = join(base, "browser/files.ts");
  for (const key of ["zlib", "tar-fs", "memfs"])
    aliases[key] = join(base, "browser/empty.ts");
  async function bundle(entry: string, tikz: string): Promise<string> {
    const output = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2022",
      minify: true,
      alias: aliases,
      plugins: [
        {
          name: "tikz-worker-entry",
          setup(plugin: PluginBuild): void {
            plugin.onResolve(
              { filter: /^bananamark$/ },
              (): OnResolveResult => ({ path: require.resolve("bananamark") }),
            );
            plugin.onResolve(
              { filter: /^peerpedia-tikz-worker$/ },
              (): OnResolveResult => ({
                path: join(upstream, "bananamark-tikz/src/worker.mjs"),
                sideEffects: true,
              }),
            );
          },
        },
      ],
      inject: [join(base, "browser/globals.ts")],
      metafile: true,
      define: {
        __dirname: '"/"',
        "import.meta.url": '"file:///bananamark-tikz/index.mjs"',
        "process.env": "{}",
        __TIKZ_WORKER__: JSON.stringify(tikz),
        __TEX_ASSETS__: JSON.stringify(texAssets),
        __RECIPE_FILES__: JSON.stringify(recipe),
      },
    });
    for (const path of Object.keys(output.metafile!.inputs)) {
      if (!path.startsWith("<")) await source(resolve(path));
    }
    return output.outputFiles[0].text;
  }
  const tikz = await bundle(join(base, "browser/tikz-worker.ts"), "");
  const renderer = await bundle(entry, tikz);
  return { source: renderer, inputs };
}
