import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";

const run = promisify(execFile);
const obsidian = fileURLToPath(new URL("..", import.meta.url));
const checkout = resolve(obsidian, "..");
const defaultOutput = join(obsidian, "dist/renderer");
const editor = join(checkout, "editor");
const theme = join(checkout, "packages/peerpedia-theme");
const sources = ["render-document.mjs", "chapter-title.js", "dialect.js"];
const nodeVersion = "v22.22.3";
const platform = "darwin-arm64";
const nodeFolder = `node-${nodeVersion}-${platform}`;
const archiveName = `${nodeFolder}.tar.gz`;
const nodeUrl = `https://nodejs.org/dist/${nodeVersion}/${archiveName}`;
// Official Node.js release SHASUMS256.txt, pinned independently of the downloaded archive.
const nodeHash = "0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207";

interface LockedPackage {
  version?: string;
  integrity?: string;
  license?: string;
}

interface ThemeAssets {
  stylesheet: string;
  tokens: string;
  license: string;
  bananaMark: { license: string };
  katex: { fonts: string[]; license: string; stylesheetLicense: string };
  tikz: { fonts: string[]; license: string };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

async function downloadNode(staging: string): Promise<string> {
  const downloads = join(obsidian, "dist/downloads");
  await mkdir(downloads, { recursive: true });
  const cached = join(downloads, archiveName);
  try {
    if (await sha256(cached) === nodeHash) return cached;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const download = join(staging, archiveName);
  await run("/usr/bin/curl", [
    "--fail", "--silent", "--show-error", "--max-time", "120", "--proto", "=https", "--output", download, nodeUrl,
  ]);
  if (await sha256(download) !== nodeHash) throw new Error("Node.js archive SHA-256 did not match the pinned release.");
  // The staging parent can be on another volume from the download cache.
  await cp(download, cached);
  await rm(download);
  return cached;
}

async function installNode(runtime: string, staging: string): Promise<object> {
  const archive = await downloadNode(staging);
  await run("/usr/bin/tar", ["-xzf", archive, "-C", staging, `${nodeFolder}/bin/node`, `${nodeFolder}/LICENSE`]);
  const executable = join(runtime, "bin/node");
  await mkdir(dirname(executable), { recursive: true });
  await cp(join(staging, nodeFolder, "bin/node"), executable);
  await cp(join(staging, nodeFolder, "LICENSE"), join(runtime, "NODE-LICENSE.txt"));
  const { stdout } = await run(executable, ["-p", "process.version+' '+process.platform+'-'+process.arch"], {
    env: { PATH: "" },
  });
  if (stdout.trim() !== `${nodeVersion} ${platform}`) throw new Error("Bundled Node.js version or architecture is incorrect.");
  return { version: nodeVersion, platform, url: nodeUrl, archiveSha256: nodeHash, executableSha256: await sha256(executable) };
}

async function copyTheme(runtime: string, staging: string): Promise<object> {
  const themeSource = join(staging, "theme-source");
  await mkdir(themeSource);
  for (const file of ["package.json", "package-lock.json", "LICENSE", "src", "scripts"]) {
    await cp(join(theme, file), join(themeSource, file), { recursive: true });
  }
  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: themeSource });
  await run("npm", ["run", "build"], { cwd: themeSource });
  const require = createRequire(join(themeSource, "package.json"));
  const manifestPath = require.resolve("@peerpedia/theme/assets.json");
  const stylesheet = require.resolve("@peerpedia/theme/style.css");
  const packageInfo: { version: string } = JSON.parse(
    await readFile(require.resolve("@peerpedia/theme/package.json"), "utf8"),
  );
  const manifest: ThemeAssets = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = [
    manifest.stylesheet, manifest.tokens, manifest.license, manifest.bananaMark.license,
    manifest.katex.license, manifest.katex.stylesheetLicense, ...manifest.katex.fonts,
    manifest.tikz.license, ...manifest.tikz.fonts,
  ];
  for (const file of files) {
    const target = join(runtime, "theme", file);
    await mkdir(dirname(target), { recursive: true });
    await cp(file === manifest.stylesheet ? stylesheet : join(dirname(manifestPath), file), target);
  }
  await cp(manifestPath, join(runtime, "theme/assets.json"));
  return {
    version: packageInfo.version,
    assetsSha256: await sha256(manifestPath),
    stylesheetSha256: await sha256(stylesheet),
    lockSha256: await sha256(join(theme, "package-lock.json")),
  };
}

async function installSite(runtime: string): Promise<object> {
  const lockSource = join(editor, "package-lock.json");
  const lock: { packages: Record<string, LockedPackage> } = JSON.parse(await readFile(lockSource, "utf8"));
  await cp(join(editor, "package.json"), join(runtime, "package.json"));
  await cp(lockSource, join(runtime, "package-lock.json"));
  await run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: runtime });
  const dependencies: Record<string, LockedPackage> = {};
  for (const [path, details] of Object.entries(lock.packages)) {
    if (!path.startsWith("node_modules/")) continue;
    const manifest = await readFile(join(runtime, path, "package.json"), "utf8")
      .catch((error: NodeJS.ErrnoException): undefined => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
    if (!manifest) continue;
    const installed: LockedPackage = JSON.parse(manifest);
    if (installed.version !== details.version) throw new Error(`Dependency version changed for ${path}.`);
    dependencies[path] = { version: installed.version, integrity: details.integrity, license: installed.license };
  }
  const site = join(runtime, "site");
  await mkdir(site);
  const sourceSha256: Record<string, string> = {};
  for (const file of sources) {
    await cp(join(editor, file), join(site, file));
    sourceSha256[`editor/${file}`] = await sha256(join(site, file));
  }
  await cp(join(checkout, "LICENSE"), join(runtime, "PEERPEDIA-LICENSE.txt"));
  return { lockSha256: await sha256(lockSource), sourceSha256, dependencies };
}

async function packageRenderer(output: string): Promise<void> {
  if (`${process.platform}-${process.arch}` !== platform) {
    throw new Error("The current renderer release targets Apple Silicon macOS.");
  }
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".renderer-build-"));
  const runtime = join(staging, "renderer");
  try {
    await mkdir(runtime);
    const node = await installNode(runtime, staging);
    const site = await installSite(runtime);
    const themeAssets = await copyTheme(runtime, staging);
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: checkout });
    await writeFile(join(runtime, "provenance.json"), JSON.stringify({
      checkoutCommit: stdout.trim(),
      node,
      site,
      theme: themeAssets,
    }, null, 2) + "\n");
    await build({
      absWorkingDir: obsidian,
      entryPoints: ["renderer/main.ts"],
      outfile: join(runtime, "renderer.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["bananamark", "./site/*"],
    });
    // Only replace the component's reserved build output. A custom destination is for a new package.
    if (output === defaultOutput) await rm(output, { recursive: true, force: true });
    await rename(runtime, output);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

await packageRenderer(resolve(process.argv[2] ?? defaultOutput));
