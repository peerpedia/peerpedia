import {build} from "esbuild";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {resolve, join, dirname} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {buildBrowserRenderer} from "../../packages/peerpedia-renderer/build-browser";
const base=dirname(fileURLToPath(import.meta.url));
const root=resolve(base,"../..");
const out=join(base,"dist");
const packageDir=join(out,"plugin");
await mkdir(packageDir,{recursive:true});
const {source:renderer, inputs}=await buildBrowserRenderer(join(base,"worker.ts"));
await writeFile(join(out,"renderer.js"),renderer);
execFileSync(process.execPath, [
  join(root, "packages/peerpedia-theme/scripts/build.mjs"),
]);
const theme = join(root, "packages/peerpedia-theme/dist");
let css = await readFile(join(theme, "style.css"), "utf8");
const manifest: { tikz: { fonts: string[] } } = JSON.parse(
  await readFile(join(theme, "assets.json"), "utf8"),
);
for (const match of [...css.matchAll(/url\(["']?(\.\/[^"')]+)["']?\)/g)]) {
  const bytes = await readFile(join(theme, match[1]));
  css = css.replaceAll(
    match[0],
    `url("data:font/${match[1].endsWith(".woff2") ? "woff2" : match[1].endsWith(".woff") ? "woff" : "ttf"};base64,${bytes.toString("base64")}")`,
  );
}
for (const path of manifest.tikz.fonts)
  css += `\n@font-face{font-family:tikzjax-${path.split("/").at(-1)!.replace(".ttf", "")};src:url("data:font/ttf;base64,${(await readFile(join(theme, path))).toString("base64")}") format("truetype")}`;
const anchored = execFileSync(
  join(root, "obsidian/node_modules/.bin/tsx"),
  [
    "-e",
    `import {nativeFiles} from './scripts/native-files';process.stdout.write(nativeFiles())`,
  ],
  { cwd: join(root, "obsidian"), maxBuffer: 1024 * 1024 },
).toString();
await build({
  entryPoints: [join(base, "plugin.ts")],
  outfile: join(packageDir, "main.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  minify: true,
  external: ["obsidian", "electron"],
  define: {
    __PREVIEW_SOURCE__: JSON.stringify(renderer),
    __THEME__: JSON.stringify(css),
    __PEERPEDIA_ANCHORED__: JSON.stringify(anchored),
  },
});
await writeFile(
  join(packageDir, "manifest.json"),
  JSON.stringify(
    {
      id: "peerpedia-community-prototype",
      name: "Peerpedia Community Prototype",
      version: "0.0.1",
      minAppVersion: "1.15.1",
      description:
        "Validate offline three-file distribution in a disposable vault.",
      author: "Peerpedia",
      isDesktopOnly: true,
    },
    null,
    2,
  ),
);
await writeFile(
  join(packageDir, "styles.css"),
  ".peerpedia-prototype-frame{width:100%;height:100%;border:0}\n",
);
await writeFile(
  join(out, "build-evidence.json"),
  JSON.stringify(
    {
      prototype: true,
      inputs,

      rendererBytes: Buffer.byteLength(renderer),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    rendererBytes: Buffer.byteLength(renderer),
    themeBytes: Buffer.byteLength(css),

  }),
);
