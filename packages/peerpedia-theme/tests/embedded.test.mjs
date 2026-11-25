import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { embeddedTheme } from "../scripts/embedded.mjs";
import { fileURLToPath } from "node:url";
import wawoff2 from "wawoff2";

/** @param {Buffer} font @returns {number} */
function glyphs(font) {
  for (let offset = 12; offset < 12 + font.readUInt16BE(4) * 16; offset += 16) {
    if (font.toString("ascii", offset, offset + 4) === "maxp")
      return font.readUInt16BE(font.readUInt32BE(offset + 8) + 4);
  }
  throw new Error("Missing glyph table");
}
test("embedded fonts use WOFF2 without removing diagram glyphs", /** @returns {Promise<void>} */ async () => {
  const dir = fileURLToPath(new URL("../dist", import.meta.url));
  execFileSync(process.execPath, [
    fileURLToPath(new URL("../scripts/build.mjs", import.meta.url)),
  ]);
  const theme = await embeddedTheme(dir);
  assert.ok(
    Object.keys(theme.resources).every(
      /** @param {string} path @returns {boolean} */ (path) =>
        path.endsWith(".woff2"),
    ),
  );
  assert.ok(!theme.css.includes(".ttf"));
  for (const path of theme.assets.tikz.fonts) {
    const bytes = Buffer.from(theme.resources[path].split(",")[1], "base64");
    assert.equal(bytes.toString("ascii", 0, 4), "wOF2");
    const original = await readFile(
      dir + "/" + path.replace(/\.woff2$/, ".ttf"),
    );
    assert.equal(
      glyphs(Buffer.from(await wawoff2.decompress(bytes))),
      glyphs(original),
    );
  }
});
