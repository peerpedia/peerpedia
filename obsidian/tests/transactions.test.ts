import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { EventRef, Vault } from "obsidian";
import { afterEach, expect, test, vi } from "vitest";

import { VaultProjectStore } from "../src/host/vault-store";
import { atomicFiles } from "../src/project/transaction";
import { recoverProject } from "../src/project/recovery";
import type { FileChange, ProjectEvent } from "../src/project/store";
import type { SourceFile } from "../src/project/types";
import { projectFixture } from "./fixtures";

const directories: string[] = [];
const events = {} as Pick<Vault, "on" | "offref">;
const fixture = projectFixture();
const [manifest, first, second] = fixture.files;

afterEach(async (): Promise<void> => {
  vi.restoreAllMocks();
  for (const path of directories.splice(0)) await fs.rm(path, { recursive: true, force: true });
});

async function setup(): Promise<string> {
  const base = await fs.mkdtemp(join(tmpdir(), "peerpedia-writes-"));
  directories.push(base);
  for (const file of fixture.files) {
    const path = join(base, "paper", file.path);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, file.text);
  }
  return fs.realpath(base);
}

function change(file: SourceFile, text: string): FileChange {
  return { path: file.path, beforeDigest: file.digest, afterText: text };
}

test("stale panel order cannot replace an externally edited manifest", async (): Promise<void> => {
  const base = await setup();
  const store = new VaultProjectStore(base, events);
  const next = JSON.stringify({ ...fixture.config, chapters: [...fixture.config.chapters!].reverse() });
  const path = join(base, "paper/paper.json");
  const external = JSON.stringify({ ...fixture.config, authors: "另外的作者" });
  await fs.writeFile(path, external);
  await expect(store.apply("paper", fixture.revision, [change(manifest, next)])).rejects.toThrow();
  expect(await fs.readFile(path, "utf8")).toBe(external);
});

test("second replacement fails after durable images; reopen exposes all versions without replay", async (): Promise<void> => {
  const base = await setup();
  const root = join(base, "paper");
  const store = new VaultProjectStore(base, events);
  const original = atomicFiles.replace.bind(atomicFiles);
  vi.spyOn(atomicFiles, "replace").mockImplementation(async (from: string, to: string): Promise<void> => {
    if (to === join(root, second.path)) throw new Error("second replacement fault");
    await original(from, to);
  });
  await expect(store.apply("paper", fixture.revision, [change(first, "第一份新稿"), change(second, "第二份新稿")])).rejects.toThrow();
  expect(await fs.readFile(join(root, first.path), "utf8")).toBe("第一份新稿");
  expect(await fs.readFile(join(root, second.path), "utf8")).toBe(second.text);
  await fs.writeFile(join(root, first.path), "随后修改");
  const [notice] = await recoverProject(root);
  expect(notice.paths).toEqual([first.path, second.path]);
  const log = JSON.parse(await fs.readFile(join(root, ".peerpedia-obsidian/recovery", notice.transactionId, "journal.json"), "utf8"));
  expect(log.expectedRevision).toBe(fixture.revision);
  expect(log.files).toMatchObject([
    { path: first.path, beforeDigest: first.digest, beforeText: first.text, afterText: "第一份新稿" },
    { path: second.path, beforeDigest: second.digest, beforeText: second.text, afterText: "第二份新稿" },
  ]);
  expect(await fs.readFile(join(root, first.path), "utf8")).toBe("随后修改");
  expect((await new VaultProjectStore(base, events).read("paper")).files[1].text).toBe("随后修改");
});

test("external edit arriving after first write survives remaining transaction", async (): Promise<void> => {
  const base = await setup();
  const root = join(base, "paper");
  const store = new VaultProjectStore(base, events);
  const original = atomicFiles.replace.bind(atomicFiles);
  vi.spyOn(atomicFiles, "replace").mockImplementation(async (from: string, to: string): Promise<void> => {
    await original(from, to);
    if (to === join(root, first.path)) await fs.writeFile(join(root, second.path), "external");
  });
  await expect(store.apply("paper", fixture.revision, [change(first, "one"), change(second, "two")])).rejects.toThrow();
  expect(await fs.readFile(join(root, second.path), "utf8")).toBe("external");
  expect(await recoverProject(root)).toHaveLength(1);
});

test("all open buffers participate; normalized untouched CRLF is safe; real unsaved text survives", async (): Promise<void> => {
  const base = await setup();
  const buffers = [first.text.replaceAll("\r\n", "\n"), "我正在写的内容"];
  const store = new VaultProjectStore(base, events, {
    buffers: (path: string): readonly string[] => path === "paper/" + first.path ? buffers : [],
  });
  await expect(store.apply("paper", fixture.revision, [change(first, "编辑器外的修改")])).rejects.toThrow();
  expect(await fs.readFile(join(base, "paper", first.path), "utf8")).toBe(first.text);
  expect(buffers[1]).toBe("我正在写的内容");
  buffers.pop();
  const updated = await store.apply("paper", fixture.revision, [change(second, "成功")]);
  expect(updated.files.find((file: SourceFile): boolean => file.path === first.path)?.text).toBe(first.text);
});

test("exclusive project creation rejects existing folder, nested projects, case aliases and traversal", async (): Promise<void> => {
  const base = await setup();
  const store = new VaultProjectStore(base, events);
  const config = JSON.stringify({ title: "", authors: "", abstract: "" });
  const files: FileChange[] = [{ path: "paper.json", beforeDigest: null, afterText: config },
    { path: "paper.md", beforeDigest: null, afterText: "" }];
  await fs.mkdir(join(base, "empty"));
  for (const name of ["empty", "paper/sub", "PAPER", "../other", ".obsidian/project"]) {
    await expect(store.create(name, files)).rejects.toThrow();
  }
  const results = await Promise.allSettled([store.create("new", files), store.create("new", files)]);
  expect(results.filter((r: PromiseSettledResult<unknown>): boolean => r.status === "fulfilled")).toHaveLength(1);
  expect((await store.read("new")).files).toHaveLength(2);
});


test("an already open external file descriptor can write after a successful swap; restart finds the displaced content", async (): Promise<void> => {
  const base = await setup();
  const root = join(base, "paper");
  const external = await fs.open(join(root, first.path), "a");
  try {
    const store = new VaultProjectStore(base, events);
    await store.apply("paper", fixture.revision, [change(first, "新正文")]);
    expect(await recoverProject(root)).toEqual([]);
    await external.writeFile("后来保存的外部内容");
    await external.sync();
    const [notice] = await recoverProject(root);
    expect(notice.paths).toEqual([first.path]);
    expect(await fs.readFile(join(root, ".peerpedia-obsidian/recovery", notice.transactionId, "file-0"), "utf8"))
      .toBe(first.text + "后来保存的外部内容");
    expect(await fs.readFile(join(root, first.path), "utf8")).toBe("新正文");
  } finally { await external.close(); }
});

test("native staging plus exclusive destination preserves an external creation and reopens original on failure", async (): Promise<void> => {
  const base = await setup();
  const reopened: string[] = [];
  const dest = join(base, "paper/new.md");
  const store = new VaultProjectStore(base, events, {
    rename: async (from: string, stage: string): Promise<(path: string) => Promise<void>> => {
      await fs.rename(join(base, from), join(base, stage));
      await fs.writeFile(dest, "第三方新建", { flag: "wx" });
      return async (path: string): Promise<void> => { reopened.push(path); };
    },
  });
  await expect(store.renameChapter(fixture, "intro", "new.md")).rejects.toThrow();
  expect(await fs.readFile(dest, "utf8")).toBe("第三方新建");
  expect(await fs.readFile(join(base, "paper", first.path), "utf8")).toBe(first.text);
  expect(reopened).toEqual(["paper/" + first.path]);
  const [record] = await new VaultProjectStore(base, events).recovery("paper");
  expect(record.paths).toContain("new.md");
  expect(await fs.readFile(join(base, "paper/.peerpedia-obsidian/recovery", record.transactionId, "moved.md"), "utf8")).toBe(first.text);
  expect(await store.recoveryFiles("paper", record.transactionId)).toContainEqual(expect.objectContaining({
    path: "new.md", versions: expect.arrayContaining([{ label: "中断时的磁盘内容", text: "第三方新建" }]),
  }));
});

test("restart after a host interruption between moving into the journal and publishing the final path", async (): Promise<void> => {
  const base = await setup();
  const store = new VaultProjectStore(base, events, {
    rename: async (from: string, stage: string): Promise<never> => {
      await fs.rename(join(base, from), join(base, stage));
      throw new Error("simulated host interruption");
    },
  });
  await expect(store.renameChapter(fixture, "intro", "new.md")).rejects.toThrow();
  const [notice] = await new VaultProjectStore(base, events).recovery("paper");
  expect(await fs.readFile(join(base, "paper/.peerpedia-obsidian/recovery", notice.transactionId, "moved.md"), "utf8")).toBe(first.text);
  expect(await fs.readFile(join(base, "paper", manifest.path), "utf8")).toBe(manifest.text);
  await expect(fs.stat(join(base, "paper/new.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("case-only native rename keeps the chapter ID and handles the old spelling on a case-insensitive volume", async (): Promise<void> => {
  const base = await setup();
  const store = new VaultProjectStore(base, events, {
    rename: async (from: string, stage: string): Promise<(path: string) => Promise<void>> => {
      await fs.rename(join(base, from), join(base, stage));
      return async (_path: string): Promise<void> => {};
    },
  });
  const target = "chapters/Z-Intro.md";
  const project = await store.renameChapter(fixture, "intro", target);
  expect(project.config.chapters![0]).toMatchObject({ id: "intro", file: target });
  expect(await fs.readFile(join(base, "paper", target), "utf8")).toBe(first.text);
  expect(await store.recovery("paper")).toEqual([]);
});

test("record stale disk, editor and proposed versions before a host autosave can replace the external text", async (): Promise<void> => {
  const base = await setup();
  const store = new VaultProjectStore(base, events, {
    buffers: (path: string): readonly string[] => path === "paper/" + first.path ? ["编辑器未保存"] : [],
  });
  const path = join(base, "paper", first.path);
  await fs.writeFile(path, "磁盘外部版本");
  await expect(store.apply("paper", fixture.revision, [change(first, "拟写版本")])).rejects.toThrow();
  await fs.writeFile(path, "编辑器未保存");
  const [record] = await store.recovery("paper");
  const [file] = await store.recoveryFiles("paper", record.transactionId);
  expect(file.versions).toEqual(expect.arrayContaining([
    { label: "拟写入", text: "拟写版本" }, { label: "中断时的编辑器内容", text: "编辑器未保存" },
    { label: "中断时的磁盘内容", text: "磁盘外部版本" },
  ]));
});

test("the watcher publishes one final revision after multi-file writes even with duplicate events", async (): Promise<void> => {
  const base = await setup();
  const callbacks: (() => void)[] = [];
  const events = { on(_name: string, callback: (file: {path: string}) => void): EventRef {
    callbacks.push((): void => callback({path: "paper/paper.json"}));
    return {} as EventRef;
  }, offref(_ref: EventRef): void {} } as Pick<Vault, "on" | "offref">;
  const store = new VaultProjectStore(base, events);
  const seen: ProjectEvent[] = [];
  const stop = store.watch("paper", (event: ProjectEvent): void => { seen.push(event); });
  try {
    await vi.waitFor((): void => expect(seen).toHaveLength(1));
    await store.apply("paper", fixture.revision, [change(first, "one"), change(second, "two")]);
    for (const callback of callbacks) callback();
    await vi.waitFor((): void => expect(seen).toHaveLength(2));
    await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, 100); });
    expect(seen[1]).toEqual({ kind: "changed", paths: [first.path, second.path] });
    expect(seen).toHaveLength(2);
  } finally { stop(); }
});

test("a replacement arriving inside the check-to-swap window survives as a readable external version", async (): Promise<void> => {
  const base = await setup();
  const store = new VaultProjectStore(base, events);
  const swap = atomicFiles.replace.bind(atomicFiles);
  vi.spyOn(atomicFiles, "replace").mockImplementation(async (stage: string, target: string): Promise<void> => {
    const external = join(base, "external-replacement");
    await fs.writeFile(external, "最后一刻保存的版本");
    await fs.rename(external, target);
    await swap(stage, target);
  });
  await expect(store.apply("paper", fixture.revision, [change(first, "面板版本")])).rejects.toThrow(/外部更改/);
  const [record] = await store.recovery("paper");
  const [file] = await store.recoveryFiles("paper", record.transactionId);
  expect(file.versions).toEqual(expect.arrayContaining([
    { label: "修改前", text: first.text }, { label: "保留的外部文件", text: "最后一刻保存的版本" },
    { label: "当前磁盘内容", text: "面板版本" },
  ]));
});
