import { watch as watchFiles, type Dirent, type FSWatcher } from "node:fs";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { TAbstractFile, Vault } from "obsidian";

import { isMissing, isRelativePath, locatePath, pathKey } from "../project/paths";
import {
  CONFIG_PATH, parsePaperConfig, projectMembers, projectRevision, type FileChange,
  type ProjectEvent, type ProjectStore,
} from "../project/store";
import { ProjectReadError, type ChapterSpec, type ProjectSnapshot, type SourceFile } from "../project/types";

import { readSource } from "../project/source-file";
import { keepConflict, PreconditionConflict, safePath, syncDirectory, writeTransaction, type WriteHost } from "../project/transaction";
import { recoverProject, recoveryFiles, type RecoveryFile, type RecoveryNotice } from "../project/recovery";

const WATCH_SETTLE_MS = 30;
// CLI fetches and plugin recovery records can contain complete copies of a project.
const PROJECT_STATE_FOLDERS = new Set([".peerpedia", ".peerpedia-obsidian", ".obsidian", ".git"]);

function checkRoot(root: string): void {
  if (root && !isRelativePath(root)) {
    throw new ProjectReadError(CONFIG_PATH, `Unsafe project root "${root}". Use a path within the vault.`);
  }
}

function isManifest(entry: Dirent): boolean {
  return pathKey(entry.name) === CONFIG_PATH && (entry.isFile() || entry.isSymbolicLink());
}

async function rejectNestedProject(base: string, root: string, absolute: string): Promise<void> {
  for (let parent = absolute; parent !== base;) {
    parent = dirname(parent);
    const entries = await readdir(parent, { withFileTypes: true });
    if (entries.some(isManifest)) {
      throw new ProjectReadError(CONFIG_PATH, `Nested projects are not supported. "${root}" is within the project at "${parent}".`);
    }
  }
  const folders = [""];
  for (const folder of folders) {
    const entries = await readdir(join(absolute, folder), { withFileTypes: true }).catch(
      (error: unknown): [] => {
        if (!isMissing(error)) throw error;
        return [];
      },
    );
    for (const entry of entries) {
      if (folder && isManifest(entry)) {
        throw new ProjectReadError(CONFIG_PATH, `Nested projects are not supported. Found "${join(folder, entry.name)}" inside this project.`);
      }
      if (entry.isDirectory() && !PROJECT_STATE_FOLDERS.has(pathKey(entry.name))) {
        folders.push(join(folder, entry.name));
      }
    }
  }
}

function isWithin(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(root + "/");
}

function relatedPath(path: string, root: string): boolean {
  const key = pathKey(path);
  if (isWithin(key, root) || isWithin(root, key)) return true;
  const separator = key.lastIndexOf("/");
  const parent = key.slice(0, Math.max(separator, 0));
  return key.slice(separator + 1) === CONFIG_PATH && isWithin(root, parent);
}

function changedPaths(previous: ProjectSnapshot, current: ProjectSnapshot): ProjectEvent[] {
  if (previous.revision === current.revision) return [];
  const before = new Map(previous.files.map((file: SourceFile): readonly [string, string] => [file.path, file.digest]));
  const after = new Map(current.files.map((file: SourceFile): readonly [string, string] => [file.path, file.digest]));
  const expected = new Set(projectMembers(current.config));
  const previouslyExpected = new Set(projectMembers(previous.config));
  const changed: string[] = [];
  const missing: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys(), ...expected])) {
    if (!after.has(path) && expected.has(path)) {
      if (before.has(path) || !previouslyExpected.has(path)) missing.push(path);
    } else if (before.get(path) !== after.get(path)) {
      changed.push(path);
    }
  }
  const events: ProjectEvent[] = [];
  if (changed.length) events.push({ kind: "changed", paths: changed });
  if (missing.length) events.push({ kind: "missing", paths: missing });
  return events;
}

// Shared with the independent language-service store so its watcher never publishes
// intermediate states from a multi-file write by this plugin instance.
const writes = new Map<string, Promise<unknown>>();

export class VaultProjectStore implements ProjectStore {
  private readonly basePath: string;

  constructor(basePath: string, private readonly vault: Pick<Vault, "on" | "offref">,
    private readonly host: WriteHost = {}) {
    this.basePath = resolve(basePath);
  }

  async read(root: string): Promise<ProjectSnapshot> {
    checkRoot(root);
    const base = await realpath(this.basePath);
    const directory = root === "" ? undefined : await locatePath(base, root, CONFIG_PATH);
    if (root && !directory) throw new ProjectReadError(CONFIG_PATH, `Missing project directory "${root}".`, "missing");
    if (directory && !directory.stat.isDirectory()) {
      throw new ProjectReadError(CONFIG_PATH, `Project root "${root}" must be a directory.`);
    }
    const absolute = directory?.absolute ?? base;
    const identities = new Map<string, string>();
    const metadata = await readSource(absolute, CONFIG_PATH, identities);
    if (!metadata) throw new ProjectReadError(CONFIG_PATH, `Missing paper.json in "${root || "/"}".`, "missing");
    await rejectNestedProject(base, root, absolute);
    const config = parsePaperConfig(metadata.text);
    const files = [metadata];
    for (const path of projectMembers(config).slice(1)) {
      const file = await readSource(absolute, path, identities);
      if (file) files.push(file);
    }
    return { root, config, files, revision: projectRevision(files) };
  }

  private async directory(root: string): Promise<string> {
    checkRoot(root);
    if (root) safePath(root);
    const base = await realpath(this.basePath);
    if (!root) return base;
    const dir = await locatePath(base, root, CONFIG_PATH);
    if (!dir?.stat.isDirectory()) throw new Error("论文文件夹不存在。");
    return dir.absolute;
  }

  async localPath(root: string, path: string): Promise<string> {
    const found = await locatePath(await this.directory(root), path, path);
    if (!found) throw new Error("找不到原文件。");
    return found.absolute;
  }

  async recoveryFiles(root: string, id: string): Promise<readonly RecoveryFile[]> {
    return recoveryFiles(await this.directory(root), id);
  }

  async recovery(root: string): Promise<readonly RecoveryNotice[]> {
    return recoverProject(await this.directory(root));
  }

  async member(root: string, path: string): Promise<SourceFile | undefined> {
    safePath(path);
    return readSource(await this.directory(root), path, new Map());
  }

  private async exclusive(root: string, operation: () => Promise<ProjectSnapshot>): Promise<ProjectSnapshot> {
    const key = pathKey(join(this.basePath, root));
    if (writes.has(key)) throw new Error("论文正在保存，请稍后再试。");
    const pending = operation();
    writes.set(key, pending);
    try { return await pending; } finally { writes.delete(key); }
  }

  create(root: string, changes: readonly FileChange[]): Promise<ProjectSnapshot> {
    return this.exclusive(root, async (): Promise<ProjectSnapshot> => {
      safePath(root);
      if (changes.some((change: FileChange): boolean => change.beforeDigest !== null || change.afterText === null)) {
        throw new Error("新论文只能创建新文件。");
      }
      const config = parsePaperConfig(changes.find((change: FileChange): boolean => change.path === CONFIG_PATH)?.afterText ?? "");
      const members = projectMembers(config);
      const keys = new Set<string>();
      for (const member of members) safePath(member);
      for (const change of changes) {
        safePath(change.path);
        const key = pathKey(change.path);
        if (!members.includes(change.path) || keys.has(key)) throw new Error("发现重复路径或不属于论文的文件。");
        keys.add(key);
      }
      const base = await realpath(this.basePath);
      const parent = dirname(root);
      if (parent !== ".") await this.directory(parent);
      if (await locatePath(base, root, CONFIG_PATH)) throw new Error("目标文件夹已存在，请选择新名称。");
      const directory = join(base, root);
      await rejectNestedProject(base, root, directory);
      await mkdir(directory); // exclusive even if another process creates it after our check
      await syncDirectory(dirname(directory));
      return writeTransaction(directory, root, null, changes, this.host, (): Promise<ProjectSnapshot> => this.read(root));
    });
  }

  apply(root: string, expectedRevision: string, changes: readonly FileChange[]): Promise<ProjectSnapshot> {
    return this.save(root, expectedRevision, changes);
  }

  renameChapter(project: ProjectSnapshot, id: string, to: string): Promise<ProjectSnapshot> {
    const chapters = project.config.chapters ?? [];
    const chapter = chapters.find((item: ChapterSpec): boolean => item.id === id);
    const source = project.files.find((file: SourceFile): boolean => file.path === chapter?.file);
    if (!chapter || !source) return Promise.reject(new Error("找不到章节原文件。"));
    if (chapter.file === to) return this.apply(project.root, project.revision, []);
    const config = { ...project.config, chapters: chapters.map((item: ChapterSpec): ChapterSpec =>
      item.id === id ? { ...item, file: to } : item) };
    return this.save(project.root, project.revision, [
      { path: chapter.file, beforeDigest: source.digest, afterText: null },
      { path: to, beforeDigest: null, afterText: source.text },
      { path: CONFIG_PATH, beforeDigest: project.files.find((f: SourceFile): boolean => f.path === CONFIG_PATH)!.digest,
        afterText: JSON.stringify(config, null, 2) + "\n" },
    ], { from: chapter.file, to });
  }

  private save(root: string, expectedRevision: string, changes: readonly FileChange[],
    move?: { from: string; to: string }): Promise<ProjectSnapshot> {
    return this.exclusive(root, async (): Promise<ProjectSnapshot> => {
      const directory = await this.directory(root);
      const project = await this.read(root);
      try {
        if (project.revision !== expectedRevision) throw new PreconditionConflict("论文已在其他地方更改，请重新载入后核对。");
        return await writeTransaction(directory, root, project, changes, this.host, (): Promise<ProjectSnapshot> => this.read(root), move);
      } catch (error: unknown) {
        if (error instanceof PreconditionConflict) await keepConflict(directory, project, expectedRevision, changes, this.host);
        throw error;
      }
    });
  }

  watch(root: string, listener: (event: ProjectEvent) => void): () => void {
    checkRoot(root);
    const key = pathKey(root);
    let previous: ProjectSnapshot | undefined;
    let previousError: string | undefined;
    let stopped = false;
    let working = false;
    let queued = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      queued = false;
      working = true;
      try {
        const writing = writes.get(pathKey(join(this.basePath, root)));
        if (writing) await writing.catch((): void => {});
        const current = await this.read(root);
        if (writes.has(pathKey(join(this.basePath, root)))) { queued = true; return; }
        if (stopped) return;
        if (previous) {
          const events = changedPaths(previous, current);
          for (const event of events) listener(event);
          if (previousError && events.length === 0) listener({ kind: "changed", paths: [CONFIG_PATH] });
        } else {
          // Publish a baseline as well as subsequent changes. Files can change
          // while the asynchronous first read is in progress.
          listener({ kind: "changed", paths: current.files.map((file: SourceFile): string => file.path) });
          const present = new Set(current.files.map((file: SourceFile): string => file.path));
          const missing = projectMembers(current.config).filter((path: string): boolean => !present.has(path));
          if (missing.length) listener({ kind: "missing", paths: missing });
        }
        previous = current;
        previousError = undefined;
      } catch (error: unknown) {
        if (stopped) return;
        const detail = error instanceof ProjectReadError
          ? error
          : new ProjectReadError(CONFIG_PATH, error instanceof Error ? error.message : String(error));
        const failure = JSON.stringify([detail.kind, detail.issue]);
        if (failure !== previousError) listener({ kind: detail.kind, paths: [detail.issue.path] });
        previousError = failure;
      } finally {
        working = false;
        if (queued && !stopped) schedule();
      }
    };
    const schedule = (): void => {
      queued = true;
      if (working || stopped || timer !== undefined) return;
      timer = setTimeout((): void => {
        timer = undefined;
        void refresh();
      }, WATCH_SETTLE_MS);
    };
    const onFile = (file: TAbstractFile, oldPath?: string): void => {
      if (relatedPath(file.path, key) || (oldPath !== undefined && relatedPath(oldPath, key))) schedule();
    };

    // The vault can omit JSON and YAML if Obsidian is configured to detect only
    // supported extensions. Observe raw filesystem changes for those members.
    const watcher: FSWatcher = watchFiles(this.basePath, { recursive: true, persistent: false },
      (_event: string, filename: string | null): void => {
        if (filename === null || relatedPath(filename, key)) schedule();
      },
    );
    watcher.on("error", (): void => { schedule(); });
    const refs = [
      this.vault.on("create", onFile), this.vault.on("modify", onFile),
      this.vault.on("delete", onFile), this.vault.on("rename", onFile),
    ];
    void refresh();

    return (): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      watcher.close();
      for (const ref of refs) this.vault.offref(ref);
    };
  }
}
