import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";

const project = fileURLToPath(new URL("..", import.meta.url));
/** @typedef {{license: string, directory: string, fonts: string[]}} FontAssets */

/** @param {import('postcss').Root} sheet @param {string} scope @returns {void} */
function assertScoped(sheet, scope) {
  const anchors = new Set([scope, ":where(" + scope + ")"]);
  sheet.walkAtRules(
    /** @param {import('postcss').AtRule} rule @returns {void} */
    (rule) => {
      assert.ok(
        ["font-face", "media", "supports"].includes(rule.name),
        rule.toString(),
      );
    },
  );
  sheet.walkRules(
    /** @param {import('postcss').Rule} rule @returns {void} */
    (rule) => {
      for (const selector of selectorParser().astSync(rule.selector).nodes) {
        assert.ok(
          anchors.has(selector.first.toString().trim()),
          selector.toString(),
        );
        const axis = selector.nodes.find(isCombinator);
        if (axis)
          assert.ok(["", ">"].includes(axis.value.trim()), selector.toString());
      }
    },
  );
}

/** @param {import('postcss-selector-parser').Node} node @returns {node is import('postcss-selector-parser').Combinator} */
function isCombinator(node) {
  return node.type === "combinator";
}

/** @param {import('postcss').Root} sheet @returns {Set<string>} */
function stylesheetURLs(sheet) {
  /** @type {Set<string>} */
  const urls = new Set();
  sheet.walkDecls(
    /** @param {import('postcss').Declaration} decl @returns {void} */
    (decl) => {
      valueParser(decl.value).walk(
        /** @param {import('postcss-value-parser').Node} node @returns {void} */
        (node) => {
          if (node.type !== "function" || node.value.toLowerCase() !== "url")
            return;
          assert.equal(node.nodes.length, 1, decl.value);
          const path = node.nodes[0].value;
          assert.match(path, /^\.\/fonts\/katex\/[^/]+\.(woff2|woff|ttf)$/);
          urls.add(path.slice(2));
        },
      );
    },
  );
  return urls;
}

/** @param {NodeJS.Require} resolveFromConsumer @param {FontAssets} group @returns {Promise<void>} */
async function assertInstalledFonts(resolveFromConsumer, group) {
  const license = await readFile(
    resolveFromConsumer.resolve("@peerpedia/theme/" + group.license),
    "utf8",
  );
  assert.match(license, /Copyright/i);
  assert.ok(group.fonts.length > 1);
  const installed = new Set();
  for (const font of group.fonts) {
    const path = resolveFromConsumer.resolve("@peerpedia/theme/" + font);
    assert.ok(
      path.includes(sep + group.directory.replaceAll("/", sep) + sep),
      path,
    );
    const bytes = await readFile(path);
    assert.ok(bytes.byteLength > 100, font);
    const magic = bytes.subarray(0, 4).toString("hex");
    assert.ok(["00010000", "774f4646", "774f4632"].includes(magic), font);
    installed.add(path);
  }
  const directory = dirname(installed.values().next().value);
  for (const file of await readdir(directory)) {
    if (
      file.endsWith(".ttf") ||
      file.endsWith(".woff") ||
      file.endsWith(".woff2")
    ) {
      assert.ok(installed.has(join(directory, file)), file);
    }
  }
}

/** @returns {Promise<void>} */
async function verifyPackedTheme() {
  const scratch = await mkdtemp(join(tmpdir(), "peerpedia-theme-"));
  try {
    // Pack a fresh source tree so existing dist files cannot hide a broken prepack hook.
    const cleanSource = join(scratch, "theme-source");
    await mkdir(cleanSource);
    for (const entry of [
      "package.json",
      "LICENSE",
      "README.md",
      "src",
      "scripts",
    ]) {
      await cp(join(project, entry), join(cleanSource, entry), {
        recursive: true,
      });
    }
    await symlink(
      join(project, "node_modules"),
      join(cleanSource, "node_modules"),
      "junction",
    );
    const archives = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], {
        cwd: cleanSource,
        encoding: "utf8",
      }),
    );
    const consumer = join(scratch, "package.json");
    await writeFile(consumer, '{"private":true}');
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(scratch, archives[0].filename),
      ],
      { cwd: scratch },
    );
    const require = createRequire(consumer);
    const installedPackage = require("@peerpedia/theme/package.json");
    assert.equal(installedPackage.dependencies, undefined);
    const manifest = require("@peerpedia/theme/assets.json");
    const stylePath = require.resolve("@peerpedia/theme/style.css");
    const sheet = postcss.parse(await readFile(stylePath, "utf8"), {
      from: stylePath,
    });
    assertScoped(sheet, ".peerpedia-article");

    const tokensPath = require.resolve("@peerpedia/theme/tokens.css");
    assertScoped(
      postcss.parse(await readFile(tokensPath, "utf8"), { from: tokensPath }),
      ".peerpedia-theme-tokens",
    );

    const urls = stylesheetURLs(sheet);
    assert.ok(urls.has("fonts/katex/KaTeX_Main-Regular.woff2"));
    assert.deepEqual(urls, new Set(manifest.katex.fonts));
    for (const url of urls) await access(join(dirname(stylePath), url));
    await assertInstalledFonts(require, manifest.katex);
    const katexFontLicense = await readFile(
      require.resolve("@peerpedia/theme/" + manifest.katex.license),
      "utf8",
    );
    assert.match(katexFontLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
    const katexStylesheetLicense = await readFile(
      require.resolve("@peerpedia/theme/" + manifest.katex.stylesheetLicense),
      "utf8",
    );
    assert.match(katexStylesheetLicense, /MIT License/i);
    assert.ok(manifest.tikz.fonts.includes("tikz/cmr10.ttf"));
    await assertInstalledFonts(require, manifest.tikz);
    const themeLicense = await readFile(
      require.resolve("@peerpedia/theme/" + manifest.license),
      "utf8",
    );
    assert.match(themeLicense, /MIT License/i);
    const bananaMarkLicense = await readFile(
      require.resolve("@peerpedia/theme/" + manifest.bananaMark.license),
      "utf8",
    );
    assert.match(bananaMarkLicense, /MIT License/i);
    assert.equal(manifest.stylesheet, "style.css");
    assert.equal(manifest.tokens, "tokens.css");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test(
  "a packed theme installs with scoped CSS and local fonts",
  verifyPackedTheme,
);
