import { build } from "esbuild";
import { expect, test } from "vitest";

test("the shared browser renderer ships one HTML parser implementation", async (): Promise<void> => {
  const output = await build({
    entryPoints: ["../packages/peerpedia-renderer/core.mjs"],
    bundle: true, write: false, platform: "browser", format: "esm", metafile: true,
  });
  const parsers = new Set(Object.keys(output.metafile!.inputs)
    .filter((path: string): boolean => /node_modules\/parse5\//.test(path))
    .map((path: string): string => path.slice(0, path.lastIndexOf("node_modules/parse5/") + "node_modules/parse5".length)));
  expect(parsers.size).toBe(1);
});
