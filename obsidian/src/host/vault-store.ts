import { constants, watch as watchFiles, type Dirent, type FSWatcher } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { TAbstractFile, Vault } from "obsidian";

import { isMissing, isRelativePath, locatePath, pathKey } from "../project/paths";
import {
  CONFIG_PATH, parsePaperConfig, projectMembers, projectRevision, sourceDigest,
  type ProjectEvent, type ProjectStore,
} from "../project/store";
import { ProjectReadError, type ProjectSnapshot, type SourceFile } from "../project/types";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
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

async function readSource(
  root: string,
  path: string,
  identities: Map<string, string>,
): Promise<SourceFile | undefined> {
  try {
    const disk = await locatePath(root, path, path);
    if (!disk) return undefined;
    if (!disk.stat.isFile()) throw new ProjectReadError(path, `Project path "${path}" must name a regular file.`);
    if (await realpath(disk.absolute) !== disk.absolute) {
      throw new ProjectReadError(path, `Do not use a symlink in project path "${path}".`);
    }
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await open(disk.absolute, flags);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.dev !== disk.stat.dev || stat.ino !== disk.stat.ino) {
        throw new ProjectReadError(path, `Project file "${path}" changed while opening it. Reload the project.`);
      }
      const key = `${stat.dev}:${stat.ino}`;
      const alias = identities.get(key);
      if (alias !== undefined) {
        throw new ProjectReadError(path, `Paths "${alias}" and "${path}" refer to the same file.`);
      }
      const bytes = await handle.readFile();
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        throw new ProjectReadError(path, `Project file "${path}" is not valid UTF-8.`);
      }
      identities.set(key, path);
      return { path, text, digest: sourceDigest(bytes) };
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
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

export class VaultProjectStore implements Pick<ProjectStore, "read" | "watch"> {
  private readonly basePath: string;

  constructor(basePath: string, private readonly vault: Pick<Vault, "on" | "offref">) {
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
        const current = await this.read(root);
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
