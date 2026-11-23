import { execFileSync } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { EventRef, TAbstractFile, Vault } from "obsidian";
import { afterEach, expect, test, vi } from "vitest";

import { VaultProjectStore } from "../src/host/vault-store";
import { toPublicationDocument, validateProject } from "../src/project/document";
import type { ProjectEvent } from "../src/project/store";
import type { ChapterSpec, PaperConfig, ProjectIssue, ProjectSnapshot, SourceFile } from "../src/project/types";
import { editFixture, projectFixture } from "./fixtures";

type ObservedEvent = "create" | "modify" | "delete" | "rename";
type VaultListener = (file: TAbstractFile, oldPath: string) => void;

class VaultEvents implements Pick<Vault, "on" | "offref"> {
  private readonly events = new Map<EventRef, { name: ObservedEvent; callback: VaultListener }>();

  on(name: ObservedEvent, callback: VaultListener): EventRef {
    const ref = {} as EventRef;
    this.events.set(ref, { name, callback });
    return ref;
  }

  offref(ref: EventRef): void {
    this.events.delete(ref);
  }

  emit(name: ObservedEvent, path: string, oldPath: string = ""): void {
    for (const event of this.events.values()) {
      if (event.name === name) event.callback({ path } as TAbstractFile, oldPath);
    }
  }

  get size(): number {
    return this.events.size;
  }
}

const temporary: string[] = [];
const subscriptions: (() => void)[] = [];

afterEach(async (): Promise<void> => {
  for (const stop of subscriptions.splice(0)) stop();
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function writeProject(vaultPath: string, project: ProjectSnapshot): Promise<string> {
  const root = join(vaultPath, project.root);
  for (const file of project.files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.text);
  }
  return root;
}

async function vaultFixture(project: ProjectSnapshot = projectFixture()): Promise<{
  path: string; root: string; vault: VaultEvents; store: VaultProjectStore;
}> {
  const path = await mkdtemp(join(tmpdir(), "peerpedia-project-"));
  temporary.push(path);
  const vault = new VaultEvents();
  const root = await writeProject(path, project);
  return { path, root, vault, store: new VaultProjectStore(path, vault) };
}

function configure(project: ProjectSnapshot, config: PaperConfig): ProjectSnapshot {
  return editFixture(project, "paper.json", JSON.stringify(config));
}

test("single-file projects allow draft metadata and preserve source bytes", async (): Promise<void> => {
  const project = projectFixture();
  const configured = configure(project, { ...project.config, chapters: [] });
  const source = "\uFEFF# 草稿\r\n\r\n";
  const { store } = await vaultFixture(editFixture(configured, "paper.md", source));
  const snapshot = await store.read("paper");
  const document = toPublicationDocument(snapshot);
  expect(document.markdown).toBe(source);
  expect(document.chapters).toEqual([]);
  expect(document.bibliography).toBe(project.files[3].text);
  expect(snapshot.files.map((file: SourceFile): string => file.path)).toEqual(["paper.json", "paper.md", "references.yaml"]);
  expect(snapshot.files.find((file: SourceFile): boolean => file.path === "paper.md")?.digest)
    .toBe(editFixture(project, "paper.md", source).files.at(-1)?.digest);
});

test("the chapter order, raw text, sorted categories and bibliography match the CLI", async (): Promise<void> => {
  const { root, store } = await vaultFixture();
  const snapshot = await store.read("paper");
  const document = toPublicationDocument(snapshot);
  const cli = fileURLToPath(new URL("../../cli/", import.meta.url));
  const expected: unknown = JSON.parse(execFileSync("python3", [
    "-c", "import json, sys; from pathlib import Path; from peerpedia_cli.main import local_document; print(json.dumps(local_document(Path(sys.argv[1]))))", root,
  ], { cwd: cli, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }));
  expect(document).toEqual(expected);
  expect(document.markdown).toBe(projectFixture().files.slice(1, 3)
    .map((file: SourceFile): string => file.text).join("\n\n"));
  expect(snapshot.revision).toBe(projectFixture().revision);
});

test("chapter titles come from the website heading rules even when manifest titles differ", (): void => {
  const project = projectFixture();
  const text = "~~~md\n# Code\n~~~\n\n> # Quote\n\n::: theorem\n# Inside\n:::\n\n## Secondary\n\n# **Actual** [title](https://example.org) {@sec:actual}";
  const first = editFixture(project, project.config.chapters![0].file, text);
  const snapshot = editFixture(first, project.config.chapters![1].file, "No heading\n");
  const document = toPublicationDocument(snapshot);
  expect(document.chapters.map((chapter: { title: string }): string => chapter.title))
    .toEqual(["Actual title", "Untitled chapter"]);
  expect(snapshot.config.chapters?.map((chapter: ChapterSpec): string => chapter.title)).toEqual(["Introduction", "Proof"]);
});

test("64 explicit chapters are valid and the 65th produces a diagnosis without losing text", (): void => {
  let project = projectFixture();
  const chapters: ChapterSpec[] = [];
  for (let index = 1; index <= 65; index++) {
    const item = { id: `ch${index}`, title: `Chapter ${index}`, file: `chapters/${index}.md` };
    chapters.push(item);
    project = editFixture(project, item.file, `# ${item.title}\n`);
  }
  expect(validateProject(configure(project, { ...project.config, chapters: chapters.slice(0, 64) }))).toEqual([]);
  const draft = configure(project, { ...project.config, chapters });
  expect(validateProject(draft)).toContainEqual(expect.objectContaining({ path: "paper.json", message: expect.stringMatching(/64 chapters/) }));
  expect(toPublicationDocument(draft).chapters).toHaveLength(65);
});

test("validation counts UTF-8 bytes, book separators and bibliography together", (): void => {
  const project = projectFixture();
  const config = { ...project.config, chapters: [] };
  const limit = "é".repeat(1024 * 512);
  let draft = editFixture(configure(project, config), "paper.md", limit);
  draft = editFixture(draft, "references.yaml", "");
  expect(validateProject(draft)).toEqual([]);
  draft = editFixture(draft, "references.yaml", "😀");
  expect(validateProject(draft)).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/1 MiB/) }));

  const [intro, proof] = project.config.chapters!;
  let chaptered = editFixture(project, intro.file, limit);
  chaptered = editFixture(chaptered, proof.file, "");
  chaptered = editFixture(chaptered, "references.yaml", "");
  expect(validateProject(chaptered)).toContainEqual(expect.objectContaining({ message: expect.stringMatching(/1 MiB/) }));
});

test("validation reports total and individual diagram limits outside ordinary code fences", (): void => {
  const project = projectFixture();
  const config = { ...project.config, chapters: [], bibliography: undefined };
  const diagram = "```tikz\n\\begin{tikzpicture}\\end{tikzpicture}\n```\n";
  const quoted = "~~~markdown\n" + diagram.repeat(40) + "~~~\n";
  const draft = configure(project, config);
  expect(validateProject(editFixture(draft, "paper.md", quoted + diagram.repeat(32)))).toEqual([]);
  const mathDiagram = "$\\begin{tikzcd}A\\end{tikzcd}$";
  const largeDiagram = "```tikz\n" + "%".repeat(32769) + "\n```\n";
  const source = quoted + diagram.repeat(31) + largeDiagram + "\n" + mathDiagram;
  const issues = validateProject(editFixture(draft, "paper.md", source));
  expect(issues).toContainEqual(expect.objectContaining({ path: "paper.md", message: expect.stringMatching(/32 diagrams/) }));
  expect(issues).toContainEqual(expect.objectContaining({ path: "paper.md", message: expect.stringMatching(/32 KiB/) }));
});

const tikzFence = "~~~tikz\n\\begin{tikzpicture}\\end{tikzpicture}\n~~~\n";

function withDiagramCaption(caption: string): string {
  return tikzFence.replace("~~~tikz", (): string => `~~~tikz {caption="${caption}"}`);
}

test("validation counts the formula rendered within a TikZ caption", (): void => {
  const project = projectFixture();
  const draft = configure(project, { ...project.config, chapters: [], bibliography: undefined });
  const diagram = "$\\begin{tikzcd} A \\end{tikzcd}$";
  const captioned = withDiagramCaption(`D ${diagram} and \`${diagram}\``);
  expect(validateProject(editFixture(draft, "paper.md", tikzFence.repeat(30) + captioned))).toEqual([]);
  expect(validateProject(editFixture(draft, "paper.md", tikzFence.repeat(31) + captioned)))
    .toContainEqual(expect.objectContaining({ path: "paper.md", message: expect.stringMatching(/32 diagrams/) }));
});

test("validation measures TikZ formulas in captions in UTF-8 bytes", (): void => {
  const project = projectFixture();
  const draft = configure(project, { ...project.config, chapters: [], bibliography: undefined });
  const open = "\\begin{tikzcd}";
  const close = "\\end{tikzcd}";
  const padding = "é".repeat((32768 - Buffer.byteLength(open + close)) / 2);
  const boundary = open + padding + close;
  expect(Buffer.byteLength(boundary)).toBe(32768);
  expect(validateProject(editFixture(draft, "paper.md", withDiagramCaption(`$${boundary}$`)))).toEqual([]);
  const above = editFixture(draft, "paper.md", withDiagramCaption(`$${open}${padding}é${close}$`));
  expect(validateProject(above))
    .toContainEqual(expect.objectContaining({ path: "paper.md", message: expect.stringMatching(/32 KiB/) }));
});

test("an unfinished caption does not suppress diagram diagnostics elsewhere in the draft", (): void => {
  const project = projectFixture();
  const draft = configure(project, { ...project.config, chapters: [], bibliography: undefined });
  const unfinished = withDiagramCaption("<unsupported> $\\begin{tikzcd} A") + tikzFence.repeat(32);
  const snapshot = editFixture(draft, "paper.md", unfinished);
  expect(validateProject(snapshot))
    .toContainEqual(expect.objectContaining({ path: "paper.md", message: expect.stringMatching(/32 diagrams/) }));
  expect(toPublicationDocument(snapshot).markdown).toBe(unfinished);
});

test("missing members stay in the manifest and are distinct from empty drafts", async (): Promise<void> => {
  const { root, store } = await vaultFixture();
  await rm(join(root, "chapters/z-intro.md"));
  await rm(join(root, "references.yaml"));
  const missing = await store.read("paper");
  expect(missing.config.chapters?.[0].file).toBe("chapters/z-intro.md");
  expect(missing.config.bibliography).toBe("references.yaml");
  expect(validateProject(missing).map((issue: ProjectIssue): string => issue.path))
    .toEqual(["chapters/z-intro.md", "references.yaml"]);
  expect((): unknown => toPublicationDocument(missing)).toThrow(/chapters\/z-intro\.md/);
  await writeFile(join(root, "chapters/z-intro.md"), "");
  await writeFile(join(root, "references.yaml"), "");
  const empty = await store.read("paper");
  expect(empty.revision).not.toBe(missing.revision);
  expect(validateProject(empty)).toEqual([]);
  expect(toPublicationDocument(empty).chapters[0].markdown).toBe("");
  expect(toPublicationDocument(empty).bibliography).toBe("");
});

test("moving a chapter changes its path and revision but retains its ID and contents", async (): Promise<void> => {
  const { root, store } = await vaultFixture();
  const before = await store.read("paper");
  const [intro, proof] = before.config.chapters!;
  await rename(join(root, intro.file), join(root, "moved.md"));
  await writeProject(dirname(root), configure({ ...before, files: [] }, {
    ...before.config, chapters: [{ ...intro, file: "moved.md" }, proof],
  }));
  const after = await store.read("paper");
  expect(after.revision).not.toBe(before.revision);
  expect(after.config.chapters?.[0].file).toBe("moved.md");
  expect(toPublicationDocument(after).chapters[0]).toEqual(toPublicationDocument(before).chapters[0]);
});

test.each(["../outside.md", "/absolute.md", "C:/absolute.md", "chapters/./z-intro.md", "chapters\\z-intro.md"])(
  "rejects an unsafe member path %s",
  async (file: string): Promise<void> => {
    const project = projectFixture();
    const chapters = [{ ...project.config.chapters![0], file }];
    const { store } = await vaultFixture(configure(project, { ...project.config, chapters }));
    await expect(store.read("paper")).rejects.toThrow(/path/i);
  },
);

test("rejects symlinked root, manifest, directory and body paths", async (): Promise<void> => {
  const { root, path, store } = await vaultFixture();
  await symlink(root, join(path, "linked"));
  await expect(store.read("linked")).rejects.toThrow(/symlink/i);
  await rename(join(root, "chapters"), join(root, "actual-chapters"));
  await symlink(join(root, "actual-chapters"), join(root, "chapters"));
  await expect(store.read("paper")).rejects.toThrow(/symlink/i);
  await rm(join(root, "chapters"));
  await rename(join(root, "actual-chapters"), join(root, "chapters"));
  await rm(join(root, "chapters/z-intro.md"));
  await symlink("a-proof.md", join(root, "chapters/z-intro.md"));
  await expect(store.read("paper")).rejects.toThrow(/symlink/i);
  await rename(join(root, "paper.json"), join(root, "manifest.json"));
  await symlink("manifest.json", join(root, "paper.json"));
  await expect(store.read("paper")).rejects.toThrow(/symlink/i);
});

test("rejects duplicate paths, hardlink aliases, and case conflicts", async (): Promise<void> => {
  const project = projectFixture();
  const [intro, proof] = project.config.chapters!;
  const { root, store } = await vaultFixture(configure(project, {
    ...project.config, chapters: [intro, { ...proof, file: intro.file }],
  }));
  await expect(store.read("paper")).rejects.toThrow(/same file/i);
  await writeFile(join(root, "paper.json"), project.files[0].text);
  await rm(join(root, proof.file));
  await link(join(root, intro.file), join(root, proof.file));
  await expect(store.read("paper")).rejects.toThrow(/same file/i);
  await writeFile(join(root, "paper.json"), JSON.stringify({
    ...project.config, chapters: [{ ...intro, file: "chapters/Z-INTRO.MD" }, proof],
  }));
  await expect(store.read("paper")).rejects.toThrow(/case/i);
});

test("rejects case-insensitively duplicate chapter IDs", async (): Promise<void> => {
  const project = projectFixture();
  const [intro, proof] = project.config.chapters!;
  const { store } = await vaultFixture(configure(project, {
    ...project.config, chapters: [intro, { ...proof, id: "INTRO" }],
  }));
  await expect(store.read("paper")).rejects.toThrow(/chapter ID/i);
});

test("reports a nested root from both levels without merging their manifests", async (): Promise<void> => {
  const { path, store } = await vaultFixture();
  await writeProject(path, { ...projectFixture(), root: "paper/sub" });
  await expect(store.read("paper")).rejects.toThrow(/nested/i);
  await expect(store.read("paper/sub")).rejects.toThrow(/nested/i);
});

test("unknown configuration fields or invalid UTF-8 yield an error and keep original files", async (): Promise<void> => {
  const project = projectFixture();
  const text = JSON.stringify({ ...project.config, unknown_feature: { to_keep: true } });
  const { store, root } = await vaultFixture(editFixture(project, "paper.json", text));
  await expect(store.read("paper")).rejects.toThrow(/incompatible.*unknown_feature/i);
  expect(await readFile(join(root, "paper.json"), "utf8")).toBe(text);
  const chapter = { ...project.config.chapters![0], extra: "keep" };
  await writeFile(join(root, "paper.json"), JSON.stringify({ ...project.config, chapters: [chapter] }));
  await expect(store.read("paper")).rejects.toThrow(/incompatible.*extra/i);
  await writeFile(join(root, "paper.json"), project.files[0].text);
  await writeFile(join(root, "chapters/z-intro.md"), Buffer.from([0xff]));
  await expect(store.read("paper")).rejects.toThrow(/UTF-8/i);
  expect(await readFile(join(root, "chapters/z-intro.md"))).toEqual(Buffer.from([0xff]));
});

test("legacy metadata gets defaults and a plain empty draft remains readable", async (): Promise<void> => {
  const project = projectFixture();
  const { root, store } = await vaultFixture(editFixture(project, "paper.md", ""));
  await writeFile(join(root, "paper.json"), '{"title":"","authors":"","abstract":""}');
  const snapshot = await store.read("paper");
  expect(snapshot.config).toEqual({
    title: "", authors: "", abstract: "", primary_category: "", secondary_categories: [], license: "",
  });
  expect(validateProject(snapshot)).toEqual([]);
  expect(toPublicationDocument(snapshot)).toMatchObject({ markdown: "", chapters: [], bibliography: "" });
});

test("watch observes explicit members and a declared bibliography without Obsidian indexing it", async (): Promise<void> => {
  const { root, store, vault } = await vaultFixture();
  const listener = vi.fn((event: ProjectEvent): void => { void event; });
  const stop = store.watch("paper", listener);
  subscriptions.push(stop);
  await vi.waitFor((): void => expect(listener).toHaveBeenCalledWith({
    kind: "changed", paths: ["paper.json", "chapters/z-intro.md", "chapters/a-proof.md", "references.yaml"],
  }));
  listener.mockClear();
  const draft = join(root, "scratch.md");
  await writeFile(draft, "unrelated");
  vault.emit("create", "paper/scratch.md");
  await writeFile(join(root, "references.yaml"), "# changed externally\r\n");
  await vi.waitFor((): void => expect(listener).toHaveBeenCalledWith({ kind: "changed", paths: ["references.yaml"] }));
  expect(listener).toHaveBeenCalledTimes(1);
  const oldPath = "chapters/z-intro.md";
  await rename(join(root, oldPath), join(root, "moved.md"));
  vault.emit("rename", "paper/moved.md", "paper/" + oldPath);
  await vi.waitFor((): void => expect(listener).toHaveBeenCalledWith({ kind: "missing", paths: [oldPath] }));
  await rename(join(root, "moved.md"), join(root, oldPath));
  await vi.waitFor((): void => expect(listener).toHaveBeenCalledWith({ kind: "changed", paths: [oldPath] }));
  stop();
  expect(vault.size).toBe(0);
  const calls = listener.mock.calls.length;
  await writeFile(join(root, "references.yaml"), "another change");
  vault.emit("modify", "paper/references.yaml");
  await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 80); });
  expect(listener).toHaveBeenCalledTimes(calls);
});

test("CLI incoming snapshots and plugin recovery files do not register nested projects", async (): Promise<void> => {
  const { path, store } = await vaultFixture();
  for (const root of ["paper/.peerpedia/incoming-example", "paper/.peerpedia-obsidian/recovery/transaction"]) {
    await writeProject(path, { ...projectFixture(), root });
  }
  const snapshot = await store.read("paper");
  expect(snapshot.files).toHaveLength(4);
});

test("the CLI's empty bibliography setting declares no file", async (): Promise<void> => {
  const project = projectFixture();
  const configured = configure(project, { ...project.config, bibliography: "" });
  const { root, store } = await vaultFixture(configured);
  await rm(join(root, "references.yaml"));
  const snapshot = await store.read("paper");
  expect(snapshot.config.bibliography).toBe("");
  expect(validateProject(snapshot)).toEqual([]);
  expect(toPublicationDocument(snapshot).bibliography).toBe("");
});

test("watch reports invalid and missing manifests and observes their restoration", async (): Promise<void> => {
  const { root, store, vault } = await vaultFixture();
  const listener = vi.fn((event: ProjectEvent): void => { void event; });
  subscriptions.push(store.watch("paper", listener));
  await vi.waitFor((): void => expect(listener).toHaveBeenCalledTimes(1));
  const path = join(root, "paper.json");
  const original = await readFile(path);
  await writeFile(path, JSON.stringify({ extra: 1 }));
  vault.emit("modify", "paper/paper.json");
  await vi.waitFor((): void => expect(listener).toHaveBeenLastCalledWith({ kind: "conflict", paths: ["paper.json"] }));
  await rm(path);
  vault.emit("delete", "paper/paper.json");
  await vi.waitFor((): void => expect(listener).toHaveBeenLastCalledWith({ kind: "missing", paths: ["paper.json"] }));
  await writeFile(path, original);
  vault.emit("create", "paper/paper.json");
  await vi.waitFor((): void => expect(listener).toHaveBeenLastCalledWith({ kind: "changed", paths: ["paper.json"] }));
  expect(listener).toHaveBeenCalledTimes(4);
});
