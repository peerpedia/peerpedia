import { UserFacingError } from "../user-error";
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
  if (!source) throw new UserFacingError("The recovery record is incomplete.");
  const data: Journal = JSON.parse(source.text);
  if (!Array.isArray(data.files) || !data.files.every((f: FileChange): boolean => typeof f.path === "string" && isRelativePath(f.path))) {
    throw new UserFacingError("The recovery record format is invalid.");
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
    let message = "An unfinished recovery record was found. You can review the original files.";
    try {
      const data = await journalData(tree, path);
      if (await tree.source(join(path, "complete"))) {
        for (const [index, file] of data.files.entries()) {
          if (file.beforeDigest === null) continue;
          const displaced = await optionalSource(tree, join(path, data.move?.from === file.path ? "moved.md" : "file-" + index));
          if (displaced?.digest !== file.beforeDigest) paths.push(file.path);
        }
        if (!paths.length) continue;
        message = "The old file was edited again. Compare the saved file with the current contents.";
      } else {
        const observed = await observations(tree, path);
        paths = [...new Set([...data.files.map((f: FileChange): string => f.path), ...observed.map((o: Observation): string => o.path)])];
        message = data.kind === "native-conflict" ? "External changes conflict with an editor draft. Three versions were saved for review."
          : data.kind === "conflict" ? "Conflicting versions were found before saving. Compare the disk, editor, and proposed contents." : "The last save was interrupted. Compare the original, proposed, and current disk contents.";
      }
    } catch { /* Keep damaged recovery records visible. */ } finally { tree.releaseRecord(path); }
    notices.push({ transactionId: id, paths, message });
  }
  return notices;
}

export async function inspectRecovery(tree: AnchoredFiles, root: string, id: string): Promise<readonly RecoveryFile[]> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new UserFacingError("The recovery record name is invalid.");
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
      add("Before", entry.beforeText);
      add(data.kind === "native-conflict" ? "Editor draft" : "Proposed changes", entry.afterText);
      add("External changes", entry.externalText);
      const displaced = await optionalSource(tree, join(dir, data.move?.from === path ? "moved.md" : "file-" + index));
      if (displaced && displaced.text !== entry.beforeText && displaced.text !== entry.afterText) add("Saved external file", displaced.text);
    }
    for (const stopped of observed.filter((o: Observation): boolean => o.path === path)) {
      if (stopped.diskAtRead !== stopped.disk) add("Disk contents at check", stopped.diskAtRead);
      add("Disk contents at interruption", stopped.disk);
      for (const text of stopped.editors) add("Editor contents at interruption", text);
    }
    const oldSpelling = data.move?.from === path && pathKey(data.move.to) === pathKey(path) && data.move.to !== path;
    if (!oldSpelling) add("Current disk contents", (await optionalSource(tree, join(root, path)))?.text);
    result.push({ path, versions });
  }
  return result;
}
