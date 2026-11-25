import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postcss from "postcss";
import wawoff2 from "wawoff2";

/** Build-time resource adapter for hosts that distribute only JavaScript and CSS.
 * @param {string} directory
 * @returns {Promise<{css:string,assets:object,resources:Record<string,string>}>} */
export async function embeddedTheme(directory) {
  const assets = JSON.parse(
    await readFile(join(directory, "assets.json"), "utf8"),
  );
  const css = postcss.parse(
    await readFile(join(directory, assets.stylesheet), "utf8"),
  );
  css.walkAtRules(
    "font-face",
    /** @param {import('postcss').AtRule} rule @returns {void} */ (rule) => {
      rule.walkDecls(
        "src",
        /** @param {import('postcss').Declaration} decl @returns {void} */ (
          decl,
        ) => {
          const modern = decl.value
            .split(",")
            .filter(
              /** @param {string} source @returns {boolean} */ (source) =>
                source.includes(".woff2"),
            );
          if (!modern.length) throw new Error("Missing WOFF2 math font source");
          decl.value = modern.join(",");
        },
      );
    },
  );
  assets.katex.fonts = assets.katex.fonts.filter(
    /** @param {string} name @returns {boolean} */ (name) =>
      name.endsWith(".woff2"),
  );
  /** @type {Record<string,string>} */
  const resources = {};
  for (const name of [...assets.katex.fonts, ...assets.tikz.fonts]) {
    if (
      !/^[a-zA-Z0-9_./-]+$/.test(name) ||
      name.split("/").includes("..") ||
      name.startsWith("/")
    ) {
      throw new Error("Invalid packaged font path");
    }
    const original = await readFile(join(directory, name));
    const bytes = name.endsWith(".ttf")
      ? Buffer.from(await wawoff2.compress(original))
      : original;
    resources[name.replace(/\.ttf$/, ".woff2")] =
      `data:font/woff2;base64,${bytes.toString("base64")}`;
  }
  assets.tikz.fonts = assets.tikz.fonts.map(
    /** @param {string} name @returns {string} */ (name) =>
      name.replace(/\.ttf$/, ".woff2"),
  );
  return {
    assets,
    resources,
    css: css.toString(),
  };
}
