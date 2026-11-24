import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";

const project = fileURLToPath(new URL("..", import.meta.url));
const scope = selectorParser().astSync(":where(.peerpedia-article)").first
  .first;
const rootSelectors = new Set([":root", "html", "body"]);

/** @param {string} path @returns {Promise<import('postcss').Root>} */
async function readStylesheet(path) {
  return postcss.parse(await readFile(path, "utf8"), { from: path });
}

/** @param {import('postcss-selector-parser').Selector} selector @returns {void} */
function scopeSelector(selector) {
  const first = selector.first;
  if (
    (first.type === "tag" || first.type === "pseudo") &&
    rootSelectors.has(first.value)
  ) {
    first.replaceWith(scope.clone());
    return;
  }
  selector.prepend(selectorParser.combinator({ value: " " }));
  selector.prepend(scope.clone());
}

const scopeSelectors = selectorParser(
  /** @param {import('postcss-selector-parser').Root} selectors @returns {void} */
  (selectors) => {
    selectors.each(scopeSelector);
  },
);

/** @param {import('postcss').Root} stylesheet @returns {void} */
function scopeVendorStylesheet(stylesheet) {
  stylesheet.walkAtRules(
    /** @param {import('postcss').AtRule} rule @returns {void} */
    (rule) => {
      if (!["font-face", "media", "supports"].includes(rule.name)) {
        throw rule.error("Unhandled vendor at-rule");
      }
    },
  );
  stylesheet.walkRules(
    /** @param {import('postcss').Rule} rule @returns {void} */
    (rule) => {
      rule.selector = scopeSelectors.processSync(rule.selector);
    },
  );
}

/** @param {import('postcss').Root} stylesheet @param {string|null} fontDirectory @returns {string[]} */
function relocateFonts(stylesheet, fontDirectory) {
  /** @type {Set<string>} */
  const files = new Set();
  stylesheet.walkDecls(
    /** @param {import('postcss').Declaration} decl @returns {void} */
    (decl) => {
      const value = valueParser(decl.value);
      value.walk(
        /** @param {import('postcss-value-parser').Node} node @returns {void} */
        (node) => {
          if (node.type !== "function" || node.value.toLowerCase() !== "url")
            return;
          const relative = node.nodes[0]?.value;
          if (
            !fontDirectory ||
            node.nodes.length !== 1 ||
            !relative ||
            posix.dirname(relative) !== "fonts"
          ) {
            throw decl.error("Unhandled vendor asset URL");
          }
          const name = posix.basename(relative);
          files.add(name);
          node.nodes[0].value = "./" + posix.join(fontDirectory, name);
        },
      );
      decl.value = value.toString();
    },
  );
  return [...files].sort();
}

const bananaMarkCSS = fileURLToPath(
  import.meta.resolve("bananamark/style.css"),
);
const bananaMark = dirname(dirname(bananaMarkCSS));
const katex = dirname(fileURLToPath(import.meta.resolve("katex/package.json")));
const tikz = dirname(
  fileURLToPath(import.meta.resolve("node-tikzjax/package.json")),
);

const bananaMarkSheet = await readStylesheet(bananaMarkCSS);
const katexSheet = await readStylesheet(join(katex, "dist/katex.min.css"));
scopeVendorStylesheet(bananaMarkSheet);
scopeVendorStylesheet(katexSheet);
relocateFonts(bananaMarkSheet, null);
const katexDirectory = "fonts/katex";
const katexFonts = relocateFonts(katexSheet, katexDirectory);
const tikzSource = join(tikz, "css/bakoma/ttf");
const tikzFonts = (await readdir(tikzSource))
  .filter(
    /** @param {string} file @returns {boolean} */
    (file) => file.endsWith(".ttf"),
  )
  .sort();
const tokens = await readStylesheet(join(project, "src/tokens.css"));
const siteTokens = tokens.clone();
siteTokens.walkRules(
  /** @param {import('postcss').Rule} rule @returns {void} */
  (rule) => {
    rule.selector = ":where(.peerpedia-theme-tokens)";
  },
);
const article = await readStylesheet(join(project, "src/article.css"));
const bananaMarkPresentation = await readStylesheet(
  join(project, "src/bananamark.css"),
);

// Editor syntax is generated from the same upstream classes and Peerpedia tokens.
// No article layout or fonts escape into the native editor.
const syntax = postcss.root();
for (const sheet of [tokens, bananaMarkSheet, bananaMarkPresentation]) {
  sheet.walkRules(
    /** @param {import('postcss').Rule} rule @returns {void} */
    (rule) => {
      const tokenRule =
        sheet === tokens ||
        (sheet === bananaMarkPresentation &&
          rule.selector === ".peerpedia-article");
      if (!tokenRule && !rule.selector.includes(".bm-hl-")) return;
      const copy = rule.clone();
      copy.selector = tokenRule
        ? ".peerpedia-writing"
        : rule.selector.replaceAll(
            ":where(.peerpedia-article)",
            ".peerpedia-writing",
          );
      syntax.append(copy);
    },
  );
}

const manifest = {
  stylesheet: "style.css",
  tokens: "tokens.css",
  license: "licenses/peerpedia-MIT.txt",
  bananaMark: { license: "licenses/bananamark-MIT.txt" },
  katex: {
    license: "licenses/katex-OFL-1.1.txt",
    stylesheetLicense: "licenses/katex-MIT.txt",
    directory: katexDirectory,
    fonts: katexFonts.map(
      /** @param {string} file @returns {string} */
      (file) => posix.join(katexDirectory, file),
    ),
  },
  tikz: {
    license: "tikz/LICENCE",
    directory: "tikz",
    fonts: tikzFonts.map(
      /** @param {string} file @returns {string} */
      (file) => "tikz/" + file,
    ),
  },
};

const staging = await mkdtemp(join(project, ".theme-build-"));
try {
  await mkdir(join(staging, "licenses"));
  await mkdir(join(staging, katexDirectory), { recursive: true });
  await mkdir(join(staging, manifest.tikz.directory));

  await writeFile(
    join(staging, manifest.stylesheet),
    [
      "/*! Peerpedia, BananaMark and KaTeX. See the licenses in assets.json. */",
      tokens.toString(),
      katexSheet.toString(),
      bananaMarkSheet.toString(),
      article.toString(),
      bananaMarkPresentation.toString(),
    ].join("\n") + "\n",
  );
  await writeFile(join(staging, manifest.tokens), siteTokens.toString() + "\n");
  await writeFile(join(staging, "syntax.css"), syntax.toString() + "\n");
  await writeFile(
    join(staging, "assets.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await cp(join(project, "LICENSE"), join(staging, manifest.license));
  await cp(
    join(bananaMark, "LICENSE"),
    join(staging, manifest.bananaMark.license),
  );
  await cp(
    join(katex, "LICENSE"),
    join(staging, manifest.katex.stylesheetLicense),
  );
  await cp(
    join(project, "src", manifest.katex.license),
    join(staging, manifest.katex.license),
  );
  await cp(
    join(tikz, "css/bakoma/LICENCE"),
    join(staging, manifest.tikz.license),
  );
  for (const file of katexFonts) {
    await cp(
      join(katex, "dist/fonts", file),
      join(staging, katexDirectory, file),
    );
  }
  for (const file of tikzFonts) {
    await cp(
      join(tikzSource, file),
      join(staging, manifest.tikz.directory, file),
    );
  }

  await chmod(staging, 0o755);
  const distribution = join(project, "dist");
  await rm(distribution, { recursive: true, force: true });
  await rename(staging, distribution);
} finally {
  await rm(staging, { recursive: true, force: true });
}
