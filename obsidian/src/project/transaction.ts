import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { isRelativePath, locatePath, pathKey } from "./paths";
import { RECOVERY_DIR } from "./recovery";
import { readSource } from "./source-file";
import { CONFIG_PATH, parsePaperConfig, projectMembers, sourceDigest, type FileChange } from "./store";
import { ProjectReadError, type ProjectSnapshot, type SourceFile } from "./types";

const exec = promisify(execFile);
// A plain rename would discard an editor's racing replacement between check and write.
// macOS swaps both names in one syscall so the displaced inode remains inspectable.
const renameScript = 'ObjC.bindFunction("renamex_np", ["int", ["char *","char *","unsigned int"]]); ' +
  '/** @param {string[]} paths @returns {number} */ function run(paths) { return $.renamex_np(paths[0], paths[1], Number(paths[2])); }';

async function nativeRename(stage: string, target: string, flag: "2" | "4"): Promise<void> {
  if (process.platform !== "darwin") throw new Error("当前系统不支持安全替换文件。");
  const { stdout } = await exec("/usr/bin/osascript", ["-l", "JavaScript", "-e", renameScript, stage, target, flag]);
  if (stdout.trim() !== "0") throw new Error("目标路径已变化，或当前磁盘不支持安全移动。");
}

export const atomicFiles = {
  replace(stage: string, target: string): Promise<void> { return nativeRename(stage, target, "2"); }, // RENAME_SWAP
  publish(stage: string, target: string): Promise<void> { return nativeRename(stage, target, "4"); }, // RENAME_EXCL
};

export interface WriteHost {
  buffers?(vaultPath: string): readonly string[];
  /** Move through Obsidian into our private directory, then reconnect any open panes. */
  rename?(fromVaultPath: string, stagedVaultPath: string): Promise<(path: string) => Promise<void>>;
}

const reserved = new Set([".obsidian", ".git", ".peerpedia", ".peerpedia-obsidian"]);

export class PreconditionConflict extends Error {}

export function safePath(path: string): void {
  if (!isRelativePath(path) || path.split("/").some((part: string): boolean => reserved.has(pathKey(part)))) {
    throw new Error(`文件路径无效：${path}`);
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await fs.open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function durableFile(path: string, text: string, mode: number = 0o600): Promise<void> {
  const file = await fs.open(path, "wx", mode);
  try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
}

async function directories(root: string, path: string): Promise<void> {
  if (path === ".") return;
  let relative = "";
  for (const part of path.split("/")) {
    relative = relative ? relative + "/" + part : part;
    const found = await locatePath(root, relative, path);
    if (found) {
      if (!found.stat.isDirectory()) throw new Error(`文件夹路径已占用：${relative}`);
      continue;
    }
    const target = join(root, relative);
    await fs.mkdir(target, { mode: 0o700 });
    await syncDirectory(dirname(target));
  }
}

interface JournalFile extends FileChange { beforeText: string | null }
interface Version { digest: string | null; text: string | null }

function version(file: SourceFile | undefined): Version {
  return { digest: file?.digest ?? null, text: file?.text ?? null };
}

function fromText(text: string | null): Version {
  return { text, digest: text === null ? null : sourceDigest(Buffer.from(text)) };
}

function normalized(text: string | null): string | null {
  return text === null ? null : text.replace(/\r\n?/g, "\n");
}

async function newJournal(directory: string): Promise<string> {
  await directories(directory, RECOVERY_DIR);
  const recovery = join(directory, RECOVERY_DIR);
  const journal = join(recovery, randomUUID());
  await fs.mkdir(journal, { mode: 0o700 });
  await syncDirectory(recovery);
  return journal;
}

export async function keepConflict(directory: string, project: ProjectSnapshot, expectedRevision: string,
  changes: readonly FileChange[], host: WriteHost): Promise<void> {
  const disk = new Map(project.files.map((file: SourceFile): [string, SourceFile] => [file.path, file]));
  const files: JournalFile[] = [];
  const observed: {path: string; diskAtRead: string | null; disk: string | null; editors: readonly string[]}[] = [];
  for (const path of new Set([...disk.keys(), ...changes.map((change: FileChange): string => change.path)])) {
    safePath(path);
    const current = await readSource(directory, path, new Map());
    const editors = host.buffers?.(project.root ? project.root + "/" + path : path) ?? [];
    const change = changes.find((item: FileChange): boolean => item.path === path);
    if (!change && editors.every((text: string): boolean => normalized(text) === normalized(current?.text ?? null))) continue;
    const original = disk.get(path);
    const beforeDigest = change ? change.beforeDigest : original?.digest ?? null;
    files.push({ path, beforeDigest, beforeText: original?.digest === beforeDigest ? original.text : null,
      afterText: change ? change.afterText : original?.text ?? null });
    observed.push({ path, diskAtRead: original?.text ?? null, disk: current?.text ?? null, editors });
  }
  const journal = await newJournal(directory);
  await durableFile(join(journal, "journal.json"), JSON.stringify({ kind: "conflict", expectedRevision, files }, null, 2));
  await durableFile(join(journal, "observed.json"), JSON.stringify(observed, null, 2));
  await syncDirectory(journal);
}

function writeFailure(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EEXIST") return "目标路径已被占用。";
  if (code === "ENOSPC") return "磁盘空间不足。";
  if (code === "ENOENT") return "写入期间文件或文件夹被移走。";
  if (code) return "磁盘无法完成此次文件操作。";
  if (error instanceof ProjectReadError) return `请核对「${error.issue.path}」的文件内容与路径。`;
  return error instanceof Error && /[\u3400-\u9fff]/.test(error.message) ? error.message : "写入未完成。";
}

export async function writeTransaction(
  directory: string, root: string, base: ProjectSnapshot | null, changes: readonly FileChange[], host: WriteHost,
  readResult: () => Promise<ProjectSnapshot>, move?: { from: string; to: string },
): Promise<ProjectSnapshot> {
  const manifest = changes.find((change: FileChange): boolean => change.path === CONFIG_PATH);
  const config = manifest ? parsePaperConfig(manifest.afterText ?? "") : base?.config;
  if (!config) throw new Error("论文缺少 paper.json。");
  const members = new Set([...projectMembers(config), ...(base ? projectMembers(base.config) : [])]);
  const ordered = [...changes].sort((a: FileChange, b: FileChange): number =>
    Number(a.path === CONFIG_PATH) - Number(b.path === CONFIG_PATH));
  const caseOnly = !!move && dirname(move.from) === dirname(move.to) && pathKey(move.from) === pathKey(move.to);
  const keys = new Set<string>();
  for (const change of ordered) {
    safePath(change.path);
    const key = pathKey(change.path);
    if (!members.has(change.path) || (keys.has(key) && !(caseOnly && change.path === move?.to))) throw new Error(`文件不属于这次论文修改或路径重复：${change.path}`);
    keys.add(key);
  }
  const baseMembers = new Set(base ? projectMembers(base.config) : []);
  const original = new Map(base?.files.map((f: SourceFile): [string, SourceFile] => [f.path, f]));
  const expected = new Map<string, Version>();
  const identities = new Map<string, string>();
  for (const path of members) {
    safePath(path);
    // The destination spelling does not become available until the source is staged.
    if (caseOnly && path === move?.to) { expected.set(path, version(undefined)); continue; }
    const current = await readSource(directory, path, identities);
    if (base && baseMembers.has(path) && current?.digest !== original.get(path)?.digest) {
      throw new PreconditionConflict(`文件已更改，请重新载入：${path}`);
    }
    expected.set(path, version(current));
  }
  const files = ordered.map((change: FileChange): JournalFile => {
    const current = expected.get(change.path)!;
    if (current.digest !== change.beforeDigest) throw new PreconditionConflict(`文件已更改，请重新载入：${change.path}`);
    return { ...change, beforeText: current.text };
  }).filter((file: JournalFile): boolean => file.beforeText !== file.afterText);
  const vaultPath = (path: string): string => root ? root + "/" + path : path;
  const priorBuffers = new Map<string, string | null>();
  const checkBuffers = (path: string, current: Version): void => {
    const buffers = host.buffers?.(vaultPath(path)) ?? [];
    for (const buffer of buffers) {
      if (normalized(buffer) !== normalized(current.text) &&
          (!priorBuffers.has(path) || normalized(buffer) !== normalized(priorBuffers.get(path)!))) {
        throw new PreconditionConflict(`编辑器中有尚未保存的更改：${path}。请先核对并保存。`);
      }
    }
  };
  const alias = (path: string): boolean => caseOnly && (expected.get(move!.to)!.text === null ? path === move!.to : path === move!.from);
  const check = async (path: string): Promise<void> => {
    if (alias(path)) return;
    const current = expected.get(path)!;
    if (version(await readSource(directory, path, new Map())).digest !== current.digest) {
      throw new Error(`文件已被其他程序更改：${path}`);
    }
    checkBuffers(path, current);
  };
  for (const [path, current] of expected) if (!alias(path)) checkBuffers(path, current);
  if (!files.length) return readResult();

  const journal = await newJournal(directory);
  const transactionId = basename(journal);
  await durableFile(join(journal, "journal.json"), JSON.stringify({
    expectedRevision: base?.revision ?? null, move, files,
    expected: Object.fromEntries([...expected].map(([path, v]: [string, Version]): [string, string | null] => [path, v.digest])),
  }, null, 2));
  await syncDirectory(journal);
  let result: ProjectSnapshot;
  try {
    for (const [index, file] of files.entries()) {
      if (move && file.path === move.to) continue;
      const target = join(directory, file.path);
      await directories(directory, dirname(file.path));
      const staged = join(journal, `file-${index}`);
      if (!move || file.path !== move.from) {
        if (file.afterText !== null) {
          const existing = await locatePath(directory, file.path, file.path);
          await durableFile(staged, file.afterText, existing ? Number(existing.stat.mode & 0o777n) : 0o644);
        }
      }
      // Recheck all unchanged dependencies, including unrelated project members and split panes.
      for (const path of expected.keys()) await check(path);
      if (move && file.path === move.from) {
        await directories(directory, dirname(move.to));
        await check(move.to);
        await check(move.from);
        if (!host.rename) throw new Error("无法通过 Obsidian 重命名。");
        const moved = join(journal, "moved.md");
        const reconnect = await host.rename(vaultPath(move.from), vaultPath(RECOVERY_DIR + "/" + transactionId + "/moved.md"));
        await syncDirectory(journal);
        const destination = join(directory, move.to);
        try {
          if ((await readSource(journal, "moved.md", new Map()))?.digest !== file.beforeDigest) {
            throw new Error("移动时原文件已更改，已保留外部内容。");
          }
          // Publish a distinct inode: macOS can coalesce hard-link notifications for an inode
          // already indexed under its staging name, leaving the new name invisible to Obsidian.
          await fs.copyFile(moved, staged, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
          const copy = await fs.open(staged, "r");
          try { await copy.sync(); } finally { await copy.close(); }
          if ((await readSource(journal, `file-${index}`, new Map()))?.digest !== file.beforeDigest) {
            throw new Error("复制时原文件已更改，已保留外部内容。");
          }
          // A single exclusive rename also gives FSEvents one unambiguous final name.
          await atomicFiles.publish(staged, destination);
        } catch (error: unknown) {
          // Relink the original name only when it is still vacant. Never undo an external creation.
          try {
            const restore = join(journal, "restore.md");
            await fs.copyFile(moved, restore, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
            await atomicFiles.publish(restore, target);
            await syncDirectory(dirname(target));
            await reconnect(vaultPath(move.from));
          } catch { /* A racing source or unavailable pane stays untouched and is recorded below. */ }
          throw error;
        }
        await syncDirectory(dirname(destination));
        expected.set(move.to, fromText(file.beforeText));
        await reconnect(vaultPath(move.to));
      } else if (file.beforeText === null && file.afterText !== null) {
        await atomicFiles.publish(staged, target); // Exclusive creation and a single visible filesystem event.
      } else if (file.beforeText !== null) {
        if (file.afterText === null) await fs.rename(target, staged);
        else await atomicFiles.replace(staged, target);
        // The displaced file survives even if another editor replaced it during the syscall.
        if ((await readSource(journal, `file-${index}`, new Map()))?.digest !== file.beforeDigest) {
          throw new Error(`替换时发现外部更改，已保留移出的文件：${file.path}`);
        }
      }
      await syncDirectory(dirname(target));
      await syncDirectory(journal);
      expected.set(file.path, fromText(file.afterText));
      priorBuffers.set(file.path, file.beforeText);
    }
    result = await readResult();
    const actual = new Map(result.files.map((file: SourceFile): [string, string] => [file.path, file.digest]));
    for (const path of projectMembers(config)) {
      if ((actual.get(path) ?? null) !== expected.get(path)?.digest) throw new Error(`读取结果时文件已更改：${path}`);
    }
    for (const path of expected.keys()) await check(path);
    await durableFile(join(journal, "complete"), "ok\n");
    await syncDirectory(journal);
  } catch (error: unknown) {
    const observed: {path: string; disk: string | null; editors: readonly string[]}[] = [];
    for (const path of expected.keys()) {
      const current = await readSource(directory, path, new Map()).catch((): undefined => undefined);
      observed.push({ path, disk: current?.text ?? null, editors: [...host.buffers?.(vaultPath(path)) ?? [],
        ...(path === move?.from ? host.buffers?.(vaultPath(RECOVERY_DIR + "/" + transactionId + "/moved.md")) ?? [] : [])] });
    }
    await durableFile(join(journal, "observed.json"), JSON.stringify(observed, null, 2));
    await syncDirectory(journal);
    throw new Error(`${writeFailure(error)}（已保留恢复记录）`, { cause: error });
  }
  // A third-party editor may still hold an open descriptor on a displaced inode.
  // Retain it even after success so a later write through that descriptor survives.
  if (!files.some((file: JournalFile): boolean => file.beforeDigest !== null)) {
    await fs.rm(journal, { recursive: true, force: true }).catch((): void => {});
  }
  return result;
}
