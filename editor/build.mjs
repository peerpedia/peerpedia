import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const assets = "../static/vendor/bananamark";
await mkdir(assets, { recursive: true });
await cp(
  fileURLToPath(import.meta.resolve("bananamark/style.css")),
  assets + "/style.css",
);
const katex = dirname(fileURLToPath(import.meta.resolve("katex/package.json")));
await cp(join(katex, "dist/katex.min.css"), assets + "/katex.min.css");
await cp(join(katex, "dist/fonts"), assets + "/fonts", { recursive: true });
const engine = dirname(
  fileURLToPath(import.meta.resolve("node-tikzjax/package.json")),
);
await cp(join(engine, "css/bakoma/ttf"), assets + "/tikz", { recursive: true });
await cp(join(engine, "css/bakoma/LICENCE"), assets + "/tikz/LICENCE");
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const licenses = [];
for (const name of Object.keys(lock.packages).filter((name) =>
  name.startsWith("node_modules/"),
)) {
  for (const file of ["LICENSE", "LICENSE.txt", "LICENSE.md"]) {
    try {
      licenses.push(name + "\n" + (await readFile(name + "/" + file, "utf8")));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
await writeFile(assets + "/LICENSES.txt", licenses.join("\n\n-----\n\n"));
console.log("Copied BananaMark reader styles, fonts and third-party licenses.");
