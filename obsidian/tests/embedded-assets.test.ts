import { expect, test } from "vitest";
import { loadAssets } from "../../packages/peerpedia-renderer/browser/assets";
import { encodeAssets } from "../../packages/peerpedia-renderer/build-browser";

test("browser assets preserve binary engine data, Unicode filenames and alias contents", async (): Promise<void> => {
  const core = Buffer.from([0, 255, 128, 1]);
  const wasm = Buffer.from([0, 97, 115, 109]);
  const files = {
    "/tex_files/公式.tex": Buffer.from("\\def\\example{αβγ}\n"),
    "/tex_files/alias.sty": Buffer.from([255, 0, 42]),
    "/tex_files/original.sty": Buffer.from([255, 0, 42]),
    "/tex_files/empty.tex": Buffer.alloc(0),
  };
  const loaded = await loadAssets(encodeAssets(core, wasm, files));
  expect(restoreCore(loaded.core)).toEqual(core);
  expect(Buffer.from(loaded.wasm)).toEqual(wasm);
  expect(Object.keys(loaded.files).sort()).toEqual(Object.keys(files).sort());
  for (const [name, bytes] of Object.entries(files))
    expect(Buffer.from(loaded.files[name])).toEqual(bytes);
});

test("the browser archive preserves every installed offline TeX resource", async (): Promise<void> => {
  const { createRequire } = await import("node:module");
  const { readFile } = await import("node:fs/promises");
  const { gunzipSync } = await import("node:zlib");
  const require = createRequire(
    new URL("../../packages/peerpedia-renderer/package.json", import.meta.url),
  );
  const engine = require("node-tikzjax") as {
    load(): Promise<void>;
    dumpMemfs(): {
      readdirSync(path: string): string[];
      statSync(path: string): { isDirectory(): boolean };
      readFileSync(path: string): Buffer;
    };
  };
  await engine.load();
  const fs = engine.dumpMemfs();
  const files: Record<string, Uint8Array> = {};
  function collect(path: string): void {
    for (const name of fs.readdirSync(path)) {
      const file = path.replace(/\/$/, "") + "/" + name;
      if (fs.statSync(file).isDirectory()) collect(file);
      else files[file] = fs.readFileSync(file);
    }
  }
  collect("/");
  const core = gunzipSync(
    await readFile(require.resolve("node-tikzjax/tex/core.dump.gz")),
  );
  const wasm = gunzipSync(
    await readFile(require.resolve("node-tikzjax/tex/tex.wasm.gz")),
  );
  const loaded = await loadAssets(encodeAssets(core, wasm, files));
  expect(restoreCore(loaded.core).equals(core)).toBe(true);
  expect(Buffer.from(loaded.wasm).equals(wasm)).toBe(true);
  expect(Object.keys(loaded.files).sort()).toEqual(Object.keys(files).sort());
  for (const [name, bytes] of Object.entries(files)) {
    expect(Buffer.from(loaded.files[name]).equals(bytes), name).toBe(true);
  }
}, 15000);

test("sparse core restoration clears old state and omits zero pages", async (): Promise<void> => {
  const { gunzipSync } = await import("node:zlib");
  const core = Buffer.alloc(3 * 65536 + 7);
  core[65536 + 3] = 42;
  core[core.length - 1] = 255;
  const encoded = encodeAssets(core, Buffer.from([0, 97, 115, 109]), {});
  const loaded = await loadAssets(encoded);
  const target = new Uint8Array(core.length).fill(123);
  loaded.core.restore(target);
  expect(Buffer.from(target).equals(core)).toBe(true);
  target.fill(17);
  loaded.core.restore(target);
  expect(Buffer.from(target).equals(core)).toBe(true);
  expect(gunzipSync(Buffer.from(encoded, "base64")).length).toBeLessThan(
    core.length / 2,
  );
  expect((): void => loaded.core.restore(new Uint8Array(1))).toThrow();
});

function restoreCore(
  core: Awaited<ReturnType<typeof loadAssets>>["core"],
): Buffer {
  const target = Buffer.alloc(core.byteLength);
  core.restore(target);
  return target;
}

test("an entirely zero snapshot restores dirty memory", async (): Promise<void> => {
  const loaded = await loadAssets(
    encodeAssets(Buffer.alloc(65536), Buffer.from([1]), {}),
  );
  const target = new Uint8Array(65536).fill(255);
  loaded.core.restore(target);
  expect(target.every((value: number): boolean => value === 0)).toBe(true);
});
