import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const project = fileURLToPath(new URL("..", import.meta.url));

interface PluginManifest {
  id: string;
  version: string;
  minAppVersion: string;
  isDesktopOnly: boolean;
}

export async function packagePlugin(outputDirectory: string): Promise<void> {
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
    const inputs = join(staging, "build-inputs.json");
    await run("npm", ["run", "build", "--", join(plugin, "main.js"), inputs], { cwd: project });
    const manifest: PluginManifest = JSON.parse(await readFile(join(project, "../manifest.json"), "utf8"));
    const metadata: { version: string } = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    if (manifest.id !== "peerpedia" || manifest.version !== metadata.version || !manifest.isDesktopOnly) {
      throw new Error("Obsidian manifest and package metadata do not agree.");
    }
    await cp(join(project, "../manifest.json"), join(plugin, "manifest.json"));
    await chmod(plugin, 0o755);
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
