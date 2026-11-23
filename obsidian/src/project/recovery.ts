import { join } from "node:path";
import { withAnchors, type AnchoredFiles } from "./anchored-files";
import { isMissing, isRelativePath, pathKey } from "./paths";
import type { FileChange } from "./store";
import type { SourceFile } from "./types";

export const RECOVERY_DIR = ".peerpedia-obsidian/recovery";
export interface RecoveryNotice { transactionId: string; paths: readonly string[]; message: string }
export interface RecoveryVersion { label: string; text: string }
export interface RecoveryFile { path: string; versions: RecoveryVersion[] }
interface Journal {
  kind?: string;
  move?: { from: string; to: string };
  files: (FileChange & { beforeText: string | null; externalText?: string })[];
}
interface Observation { path: string; diskAtRead?: string | null; disk: string | null; editors: string[] }

async function journalData(tree: AnchoredFiles, dir: string): Promise<Journal> {
  const source = await tree.source(join(dir, "journal.json"));
  if (!source) throw new Error("恢复记录不完整。");
  const data: Journal = JSON.parse(source.text);
  if (!Array.isArray(data.files) || !data.files.every((f: FileChange): boolean => typeof f.path === "string" && isRelativePath(f.path))) {
    throw new Error("恢复记录格式无效。");
  }
  return data;
}
async function observations(tree: AnchoredFiles, dir: string): Promise<Observation[]> {
  const source = await tree.source(join(dir, "observed.json"));
  if (!source) return [];
  const entries: Observation[] = JSON.parse(source.text);
  return entries.filter((o: Observation): boolean => typeof o.path === "string" && isRelativePath(o.path));
}
async function optionalSource(tree: AnchoredFiles, path: string): Promise<SourceFile | undefined> {
  // A missing, renamed, inaccessible, or newly binary live file cannot invalidate saved versions.
  try { return await tree.source(path); } catch { return undefined; }
}

export async function recoverProject(root: string): Promise<readonly RecoveryNotice[]> {
  return withAnchors(root, (tree: AnchoredFiles): Promise<readonly RecoveryNotice[]> => recoverIn(tree, ""));
}

export async function recoverIn(tree: AnchoredFiles, root: string): Promise<readonly RecoveryNotice[]> {
  const dir = join(root, RECOVERY_DIR);
  let names: string[];
  try { names = tree.list(dir); } catch (error: unknown) { if (isMissing(error)) return []; throw error; }
  const notices: RecoveryNotice[] = [];
  for (const id of names.filter((name: string): boolean => /^[a-f0-9-]{36}$/.test(name))) {
    const path = join(dir, id);
    let paths: string[] = [];
    let message = "发现未完成的恢复记录，可查看原文件。";
    try {
      const data = await journalData(tree, path);
      if (await tree.source(join(path, "complete"))) {
        for (const [index, file] of data.files.entries()) {
          if (file.beforeDigest === null) continue;
          const displaced = await optionalSource(tree, join(path, data.move?.from === file.path ? "moved.md" : "file-" + index));
          if (displaced?.digest !== file.beforeDigest) paths.push(file.path);
        }
        if (!paths.length) continue;
        message = "旧文件收到后续写入。请核对保留的文件与当前内容。";
      } else {
        const observed = await observations(tree, path);
        paths = [...new Set([...data.files.map((f: FileChange): string => f.path), ...observed.map((o: Observation): string => o.path)])];
        message = data.kind === "native-conflict" ? "外部修改与编辑器草稿冲突，已保留三个版本供核对。"
          : data.kind === "conflict" ? "保存前发现不同版本，可核对磁盘、编辑器与拟写内容。" : "上次写入中断。可核对原稿、拟写内容和磁盘现状。";
      }
    } catch { /* Keep damaged recovery records visible. */ } finally { tree.releaseRecord(path); }
    notices.push({ transactionId: id, paths, message });
  }
  return notices;
}

export async function inspectRecovery(tree: AnchoredFiles, root: string, id: string): Promise<readonly RecoveryFile[]> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("恢复记录名称无效。");
  const dir = join(root, RECOVERY_DIR, id);
  const data = await journalData(tree, dir);
  const observed = await observations(tree, dir);
  const paths = new Set([...data.files.map((f: FileChange): string => f.path), ...observed.map((o: Observation): string => o.path)]);
  const result: RecoveryFile[] = [];
  for (const path of paths) {
    const versions: RecoveryVersion[] = [];
    const add = (label: string, text: string | null | undefined): void => {
      if (typeof text === "string") versions.push({ label, text });
    };
    const index = data.files.findIndex((f: FileChange): boolean => f.path === path);
    const entry = data.files[index];
    if (entry) {
      add("修改前", entry.beforeText);
      add(data.kind === "native-conflict" ? "编辑器草稿" : "拟写入", entry.afterText);
      add("外部修改", entry.externalText);
      const displaced = await optionalSource(tree, join(dir, data.move?.from === path ? "moved.md" : "file-" + index));
      if (displaced && displaced.text !== entry.beforeText && displaced.text !== entry.afterText) add("保留的外部文件", displaced.text);
    }
    for (const stopped of observed.filter((o: Observation): boolean => o.path === path)) {
      if (stopped.diskAtRead !== stopped.disk) add("核对时的磁盘内容", stopped.diskAtRead);
      add("中断时的磁盘内容", stopped.disk);
      for (const text of stopped.editors) add("中断时的编辑器内容", text);
    }
    const oldSpelling = data.move?.from === path && pathKey(data.move.to) === pathKey(path) && data.move.to !== path;
    if (!oldSpelling) add("当前磁盘内容", (await optionalSource(tree, join(root, path)))?.text);
    result.push({ path, versions });
  }
  return result;
}
