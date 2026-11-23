import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const project = fileURLToPath(new URL("..", import.meta.url));
const target = "darwin-arm64";

interface PluginManifest {
  id: string;
  version: string;
  minAppVersion: string;
  isDesktopOnly: boolean;
}

interface RendererProvenance {
  node: { platform: string; version: string };
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventory(root: string, prefix: string = ""): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries.sort((a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, "en"))) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(hashes, await inventory(root, relative + "/"));
    else if (entry.isFile()) hashes[relative] = await sha256(join(root, relative));
    else throw new Error(`Unsupported file in package: ${relative}`);
  }
  return hashes;
}

async function copyBundledLicenses(inputs: readonly string[], destination: string): Promise<void> {
  const roots = new Set<string>();
  for (const input of inputs) {
    if (!input.startsWith("node_modules/")) continue;
    const dependency = [...input.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+/g)].at(-1);
    if (dependency) roots.add(input.slice(0, dependency.index + dependency[0].length));
  }
  for (const root of roots) {
    const source = join(project, root);
    const notices = (await readdir(source, { withFileTypes: true })).filter(
      (file: { name: string; isFile(): boolean }): boolean => file.isFile() && /^(?:licen[sc]e|copying|notice)(?:[._-]|$)/i.test(file.name),
    );
    if (!notices.length) throw new Error(`Missing license for bundled dependency ${root}.`);
    const folder = join(destination, root.slice("node_modules/".length));
    await mkdir(folder, { recursive: true });
    for (const file of notices) await cp(join(source, file.name), join(folder, file.name));
  }
}

export async function packagePlugin(outputDirectory: string): Promise<void> {
  if (`${process.platform}-${process.arch}` !== target) throw new Error("Build the Apple Silicon package on Apple Silicon macOS.");
  const output = resolve(outputDirectory);
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  // Reserve a new path, so even an existing empty destination is left alone.
  await mkdir(output);
  let staging: string | undefined;
  let published = false;
  try {
    staging = await mkdtemp(join(parent, ".peerpedia-package-"));
    const plugin = join(staging, "peerpedia");
    await mkdir(plugin);
    const native = join(plugin, "native");
    await mkdir(native);
    await run("xcrun", ["swiftc", "-O", "-target", "arm64-apple-macosx11.0",
      join(project, "native/keychain.swift"), "-o", join(native, "keychain")]);
    const inputs = join(staging, "build-inputs.json");
    await run("npm", ["run", "build", "--", join(plugin, "main.js"), inputs], { cwd: project });
    await run("npm", ["run", "package:renderer", "--", join(plugin, "renderer")], { cwd: project });
    const manifest: PluginManifest = JSON.parse(await readFile(join(project, "manifest.json"), "utf8"));
    const metadata: { version: string } = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    if (manifest.id !== "peerpedia" || manifest.version !== metadata.version || !manifest.isDesktopOnly) {
      throw new Error("Obsidian manifest and package metadata do not agree.");
    }
    const renderer: RendererProvenance = JSON.parse(await readFile(join(plugin, "renderer/provenance.json"), "utf8"));
    if (renderer.node.platform !== target) throw new Error("The packaged renderer has the wrong platform.");
    await cp(join(project, "manifest.json"), join(plugin, "manifest.json"));
    await cp(join(project, "styles.css"), join(plugin, "styles.css"));
    await cp(join(project, "../LICENSE"), join(plugin, "LICENSE"));
    await cp(join(project, "docs/installation.md"), join(plugin, "INSTALLATION.md"));
    await copyBundledLicenses(JSON.parse(await readFile(inputs, "utf8")), join(plugin, "licenses"));
    await chmod(plugin, 0o755);
    await chmod(join(plugin, "renderer/bin/node"), 0o755);
    const hashes = await inventory(plugin);
    await writeFile(join(plugin, "package-manifest.json"), JSON.stringify({
      format: 1,
      plugin: { id: manifest.id, version: manifest.version, minAppVersion: manifest.minAppVersion },
      platform: target,
      node: renderer.node.version,
      sha256: hashes,
    }, null, 2) + "\n");
    await rename(plugin, output);
    published = true;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    if (!published) await rmdir(output);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const output = process.argv[2] ?? join(project, "dist/peerpedia");
  await packagePlugin(output);
  console.log(resolve(output));
}
