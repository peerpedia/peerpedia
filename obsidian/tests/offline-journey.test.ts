import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";

import { packagePlugin } from "../scripts/package-plugin";

const run = promisify(execFile);
const project = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/render-paper.json", import.meta.url));
const temporary: string[] = [];
const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
const hostApp = process.env.PEERPEDIA_OBSIDIAN_APP;
const finalPackage = process.env.PEERPEDIA_PLUGIN_PACKAGE;

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "peerpedia-offline-"));
  temporary.push(path);
  return path;
}

afterEach(async (): Promise<void> => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

test.skipIf(!appleSilicon)("preserves an existing package destination, including an empty directory", async (): Promise<void> => {
  const path = join(await workspace(), "peerpedia");
  await mkdir(path);
  await expect(packagePlugin(path)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readdir(path)).toEqual([]);
  await writeFile(join(path, "data.json"), "Existing installation");
  await expect(packagePlugin(path)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(join(path, "data.json"), "utf8")).toBe("Existing installation");
});

test.skipIf(!appleSilicon)("relocates exactly the three community installation assets", async (): Promise<void> => {
  const work = await workspace();
  const original = join(work, "package");
  if (finalPackage) await cp(resolve(finalPackage), original, { recursive: true });
  else await packagePlugin(original);
  const plugin = join(work, "离线 验收", "peerpedia");
  await mkdir(join(work, "离线 验收"));
  await rename(original, plugin);
  expect((await readdir(plugin)).sort()).toEqual(["main.js", "manifest.json", "styles.css"]);
  const manifest = JSON.parse(await readFile(join(plugin,"manifest.json"),"utf8"));
  expect(manifest).toMatchObject({id:"peerpedia",minAppVersion:"1.15.1",isDesktopOnly:true});
  expect((await stat(plugin)).mode & 0o777).toBe(0o755);
  expect((await stat(join(plugin,"main.js"))).size).toBeGreaterThan(1000);

}, 120_000);

test.skipIf(!appleSilicon || !hostApp || !finalPackage)(
  "opens and edits the relocated offline package in Obsidian",
  async (): Promise<void> => {
    const evidence = process.env.PEERPEDIA_ACCEPTANCE_EVIDENCE ?? await workspace();
    const { stdout } = await run(process.env.PEERPEDIA_ACCEPTANCE_PYTHON ?? "python3", [
      join(project, "scripts/validate-offline-host.py"), hostApp!, finalPackage!, fixture, evidence,
    ], { timeout: 150_000 });
    await writeFile(join(evidence, "task-8-host-journey.log"), stdout);
    expect(stdout).toContain("PASS no HTTP(S) requests from enable, source edit, or preview");
  },
  160_000,
);
