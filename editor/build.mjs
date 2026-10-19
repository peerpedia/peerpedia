import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
const destination = "../static/vendor/editor";
await mkdir(destination, { recursive: true });
await build({
  entryPoints: ["main.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  legalComments: "eof",
  outfile: destination + "/editor.js",
});
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
await writeFile(destination + "/LICENSES.txt", licenses.join("\n\n-----\n\n"));
console.log("Built the local editor bundle and third-party licenses.");
