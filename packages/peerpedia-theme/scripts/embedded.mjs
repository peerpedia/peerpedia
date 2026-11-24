import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Build-time resource adapter for hosts that distribute only JavaScript and CSS.
 * @param {string} directory
 * @returns {Promise<{css:string,assets:object,resources:Record<string,string>}>} */
export async function embeddedTheme(directory) {
  const assets = JSON.parse(
    await readFile(join(directory, "assets.json"), "utf8"),
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
    const format = name.endsWith(".woff2")
      ? "woff2"
      : name.endsWith(".woff")
        ? "woff"
        : "ttf";
    resources[name] =
      `data:font/${format};base64,${(await readFile(join(directory, name))).toString("base64")}`;
  }
  return {
    assets,
    resources,
    css: await readFile(join(directory, assets.stylesheet), "utf8"),
  };
}
