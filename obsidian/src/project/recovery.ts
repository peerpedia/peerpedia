import { constants } from "node:fs";
import fs from "node:fs/promises";
import { join } from "node:path";

import { isMissing, locatePath } from "./paths";
import { readSource } from "./source-file";

export const RECOVERY_DIR = ".peerpedia-obsidian/recovery";

export interface RecoveryNotice {
  transactionId: string;
  paths: readonly string[];
  message: string;
}

/** Inspect only. Replaying either image could destroy edits made since interruption. */
export async function recoverProject(root: string): Promise<readonly RecoveryNotice[]> {
  const recovery = await locatePath(await fs.realpath(root), RECOVERY_DIR, RECOVERY_DIR);
  if (!recovery) return [];
  const notices: RecoveryNotice[] = [];
  for (const entry of await fs.readdir(recovery.absolute, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const path = join(recovery.absolute, entry.name);
    const completed = await locatePath(path, "complete", "complete");
    let paths: string[] = [];
    let conflict = false;
    try {
      const journal = await fs.open(join(path, "journal.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await journal.stat()).isFile()) throw new Error();
        const data: { kind?: string; move?: {from: string; to: string}; files: { path: string; beforeDigest: string | null }[] } = JSON.parse(await journal.readFile("utf8"));
        conflict = data.kind === "conflict";
        paths = data.files.map((file: {path: string}): string => file.path);
        if (completed) {
          const changed: string[] = [];
          for (const [index, file] of data.files.entries()) {
            if (file.beforeDigest === null) continue;
            const moved = file.path === data.move?.from;
            if (moved && data.move) {
              const saved = await locatePath(path, "moved.md", file.path);
              const live = await locatePath(root, data.move.to, file.path);
              if (saved && live && saved.stat.dev === live.stat.dev && saved.stat.ino === live.stat.ino) continue;
            }
            const displaced = await readSource(path, moved ? "moved.md" : `file-${index}`, new Map());
            if (displaced?.digest !== file.beforeDigest) changed.push(file.path);
          }
          if (!changed.length) continue;
          paths = changed;
        }
        if (!paths.every((name: string): boolean => typeof name === "string")) throw new Error();
      } finally { await journal.close(); }
    } catch (error: unknown) {
      // A crash creating the journal can leave an incomplete record. Keep it available.
      if (!isMissing(error)) paths = [];
    }
    notices.push({ transactionId: entry.name, paths,
      message: conflict ? "保存前发现不同版本，可核对磁盘、编辑器与拟写内容。" : completed ? "旧文件收到后续写入。请核对保留的文件与当前内容。" : paths.length ? "上次写入中断。可核对原稿、拟写内容和磁盘现状。" : "发现未完成的恢复记录，可查看原文件。" });
  }
  return notices;
}

export interface RecoveryVersion { label: string; text: string }
export interface RecoveryFile { path: string; versions: RecoveryVersion[] }

/** Only read journal entries as data. Never treat their paths as mutation commands. */
export async function recoveryFiles(root: string, id: string): Promise<readonly RecoveryFile[]> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("恢复记录名称无效。");
  const journal = await locatePath(root, RECOVERY_DIR + "/" + id, RECOVERY_DIR);
  if (!journal?.stat.isDirectory()) throw new Error("找不到恢复记录。");
  const source = await readSource(journal.absolute, "journal.json", new Map());
  if (!source) throw new Error("恢复记录不完整。");
  const data: { move?: {from: string}; files: { path: string; beforeText: string | null; afterText: string | null }[] } = JSON.parse(source.text);
  const observed = await readSource(journal.absolute, "observed.json", new Map());
  const atFailure: {path: string; diskAtRead?: string | null; disk: string | null; editors: string[]}[] = observed ? JSON.parse(observed.text) : [];
  const result: RecoveryFile[] = [];
  for (const [index, entry] of data.files.entries()) {
    const versions: RecoveryVersion[] = [];
    const add = (label: string, text: string | null | undefined): void => {
      if (typeof text === "string") versions.push({ label, text });
    };
    add("修改前", entry.beforeText);
    add("拟写入", entry.afterText);
    const displaced = await readSource(journal.absolute, data.move?.from === entry.path ? "moved.md" : "file-" + index, new Map());
    if (displaced && displaced.text !== entry.beforeText && displaced.text !== entry.afterText) add("保留的外部文件", displaced.text);
    const stopped = atFailure.find((item: {path: string}): boolean => item.path === entry.path);
    if (stopped?.diskAtRead !== stopped?.disk) add("核对时的磁盘内容", stopped?.diskAtRead);
    add("中断时的磁盘内容", stopped?.disk);
    for (const text of stopped?.editors ?? []) add("中断时的编辑器内容", text);
    const disk = await readSource(root, entry.path, new Map());
    add("当前磁盘内容", disk?.text);
    result.push({ path: entry.path, versions });
  }
  return result;
}
