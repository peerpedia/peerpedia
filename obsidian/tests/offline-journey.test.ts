import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";

import { packagePlugin } from "../scripts/package-plugin";
import type { RenderRequest, RenderResponse } from "../renderer/protocol";
import type { PublicationDocument } from "../src/project/document";

const run = promisify(execFile);
const project = fileURLToPath(new URL("..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/render-paper.json", import.meta.url));
const temporary: string[] = [];
const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
const hostApp = process.env.PEERPEDIA_OBSIDIAN_APP;
const finalPackage = process.env.PEERPEDIA_PLUGIN_PACKAGE;

interface PackageManifest {
  plugin: { id: string; version: string; minAppVersion: string };
  platform: string;
  node: string;
  sha256: Record<string, string>;
}

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

test.skipIf(!appleSilicon)("relocates a verified package and renders original and edited chapters offline", async (): Promise<void> => {
  const work = await workspace();
  const original = join(work, "package");
  if (finalPackage) await cp(resolve(finalPackage), original, { recursive: true });
  else await packagePlugin(original);
  const plugin = join(work, "离线 验收", "peerpedia");
  await mkdir(join(work, "离线 验收"));
  await rename(original, plugin);
  const manifest: PackageManifest = JSON.parse(await readFile(join(plugin, "package-manifest.json"), "utf8"));
  expect(manifest).toMatchObject({
    plugin: { id: "peerpedia", version: expect.any(String), minAppVersion: "1.15.1" },
    platform: "darwin-arm64",
    node: "v22.22.3",
  });
  for (const name of [
    "manifest.json", "main.js", "styles.css", "LICENSE", "INSTALLATION.md", "licenses/bananamark-codemirror/LICENSE",
    "renderer/bin/node", "renderer/NODE-LICENSE.txt", "renderer/renderer.mjs", "renderer/theme/assets.json",
    "renderer/theme/licenses/katex-OFL-1.1.txt", "renderer/theme/tikz/LICENCE",
  ]) {
    expect(manifest.sha256[name], name).toMatch(/^[a-f0-9]{64}$/);
  }
  for (const [name, sha256] of Object.entries(manifest.sha256)) {
    const path = join(plugin, name);
    expect((await lstat(path)).isFile(), name).toBe(true);
    expect(createHash("sha256").update(await readFile(path)).digest("hex"), name).toBe(sha256);
  }
  expect((await stat(plugin)).mode & 0o777).toBe(0o755);
  const node = join(plugin, "renderer/bin/node");
  await access(node, constants.X_OK);
  const checkout = JSON.stringify(resolve(project, ".."));
  const projectRoot = JSON.stringify(await realpath(plugin));
  const policy = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${checkout}))
    (deny file-write* (subpath ${projectRoot}))`;
  const document: PublicationDocument = JSON.parse(await readFile(fixture, "utf8"));
  const edit = "可搬移包中的离线改稿。";
  const editedChapters = document.chapters!.map((chapter: NonNullable<PublicationDocument["chapters"]>[number], index: number): typeof chapter =>
    index === 1 ? { ...chapter, markdown: chapter.markdown + "\n\n" + edit } : chapter);
  const requests: RenderRequest[] = [
    { id: "open", revision: "before", document },
    { id: "edit", revision: "after", document: { ...document, markdown: document.markdown + "\n\n" + edit, chapters: editedChapters } },
  ];
  const { stdout, stderr, status, error } = spawnSync("/usr/bin/sandbox-exec", [
    "-p", policy, node, join(plugin, "renderer/renderer.mjs"),
  ], {
    input: requests.map((request: RenderRequest): string => JSON.stringify(request)).join("\n") + "\n",
    encoding: "utf8",
    cwd: work,
    env: { PATH: "", BANANAMARK_CACHE: join(work, "cache") },
    timeout: 45_000,
  });
  if (error) throw error;
  expect(status, stderr).toBe(0);
  expect(stderr).toBe("");
  const [opened, edited] = stdout.trim().split("\n").map((line: string): RenderResponse => JSON.parse(line));
  expect(opened).toMatchObject({ id: "open", revision: "before", pages: [{ id: "intro" }, { id: "proof" }] });
  expect(edited).toMatchObject({ id: "edit", revision: "after", pages: [{ id: "intro" }, { id: "proof" }] });
  if ("error" in opened || "error" in edited) throw new Error(stdout);
  expect(opened.pages[0].html).toContain("<svg");
  expect(edited.pages[1].html).toContain("<svg");
  expect(edited.pages[1].html).toContain(edit);
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
