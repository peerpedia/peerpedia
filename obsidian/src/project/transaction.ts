import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { AnchoredFiles } from "./anchored-files";

import { isRelativePath, pathKey } from "./paths";
import { RECOVERY_DIR } from "./recovery";
import { CONFIG_PATH, parsePaperConfig, projectMembers, sourceDigest, type FileChange } from "./store";
import { ProjectReadError, type ProjectSnapshot, type SourceFile } from "./types";

export const atomicFiles = {
  async replace(from: string, to: string, tree: AnchoredFiles): Promise<void> { tree.rename(from, to, "swap"); },
  async publish(from: string, to: string, tree: AnchoredFiles): Promise<void> { tree.rename(from, to, "publish"); },
  async stage(from: string, to: string, tree: AnchoredFiles): Promise<void> { tree.rename(from, to, "publish"); },
};

export interface OpenChapterMove {
  reconnect(path: string): Promise<void>;
  drafts?(): readonly string[];
  dispose?(): void;
}

export interface WriteHost {
  buffers?(vaultPath: string): readonly string[];
  ensureIndexed?(path: string, signal: () => void): Promise<void>;
  prepareRename?(fromVaultPath: string): Promise<OpenChapterMove>;
}

const reserved = new Set([".obsidian", ".git", ".peerpedia", ".peerpedia-obsidian"]);

interface ObservedVersion { path: string; disk: string | null; editors: readonly string[] }
export class PreconditionConflict extends Error {
  constructor(message: string, readonly observed?: ObservedVersion) { super(message); }
}

export function safePath(path: string): void {
  if (!isRelativePath(path) || path.split("/").some((part: string): boolean => reserved.has(pathKey(part)))) {
    throw new Error(`文件路径无效：${path}`);
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

export async function newJournal(tree: AnchoredFiles, directory: string): Promise<string> {
  await tree.directories(join(directory, RECOVERY_DIR));
  const recovery = join(directory, RECOVERY_DIR);
  const journal = join(recovery, randomUUID());
  await tree.mkdir(journal);
  return journal;
}

export async function keepConflict(tree: AnchoredFiles, project: ProjectSnapshot, expectedRevision: string,
  changes: readonly FileChange[], host: WriteHost, atCheck?: ObservedVersion): Promise<void> {
  const directory = project.root;
  const disk = new Map(project.files.map((file: SourceFile): [string, SourceFile] => [file.path, file]));
  const files: JournalFile[] = [];
  const observed: {path: string; diskAtRead: string | null; disk: string | null; editors: readonly string[]}[] = [];
  for (const path of new Set([...disk.keys(), ...changes.map((change: FileChange): string => change.path)])) {
    safePath(path);
    const current = await tree.source(join(directory, path));
    const editors = host.buffers?.(project.root ? project.root + "/" + path : path) ?? [];
    const change = changes.find((item: FileChange): boolean => item.path === path);
    if (path !== atCheck?.path && !change && editors.every((text: string): boolean => normalized(text) === normalized(current?.text ?? null))) continue;
    const original = disk.get(path);
    const beforeDigest = change ? change.beforeDigest : original?.digest ?? null;
    files.push({ path, beforeDigest, beforeText: original?.digest === beforeDigest ? original.text : null,
      afterText: change ? change.afterText : original?.text ?? null });
    observed.push({ path, diskAtRead: original?.text ?? null, disk: current?.text ?? null, editors });
    if (atCheck?.path === path && (current?.text !== atCheck.disk || JSON.stringify(editors) !== JSON.stringify(atCheck.editors))) {
      observed.push({ ...atCheck, diskAtRead: original?.text ?? null });
    }
  }
  const journal = await newJournal(tree, directory);
  await tree.file(join(journal, "journal.json"), JSON.stringify({ kind: "conflict", expectedRevision, files }, null, 2));
  await tree.file(join(journal, "observed.json"), JSON.stringify(observed, null, 2));
  await tree.sync(journal);
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
  tree: AnchoredFiles, root: string, base: ProjectSnapshot | null, changes: readonly FileChange[], host: WriteHost,
  readResult: () => Promise<ProjectSnapshot>, move?: { from: string; to: string },
): Promise<ProjectSnapshot> {
  const vaultPath = (path: string): string => root ? root + "/" + path : path;
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
    const current = await tree.source(join(root, path), identities);
    if (base && baseMembers.has(path) && current?.digest !== original.get(path)?.digest) {
      throw new PreconditionConflict(`文件已更改，请重新载入：${path}`, {path, disk:current?.text ?? null, editors:[...host.buffers?.(vaultPath(path)) ?? []]});
    }
    expected.set(path, version(current));
  }
  const files = ordered.map((change: FileChange): JournalFile => {
    const current = expected.get(change.path)!;
    if (current.digest !== change.beforeDigest) throw new PreconditionConflict(`文件已更改，请重新载入：${change.path}`);
    return { ...change, beforeText: current.text };
  }).filter((file: JournalFile): boolean => file.beforeText !== file.afterText);
  const priorBuffers = new Map<string, string | null>();
  const conflicts = new Map<string, {path: string; disk: string | null; editors: readonly string[]}>();
  const checkBuffers = (path: string, current: Version): void => {
    const buffers = host.buffers?.(vaultPath(path)) ?? [];
    for (const buffer of buffers) {
      if (normalized(buffer) !== normalized(current.text) &&
          (!priorBuffers.has(path) || normalized(buffer) !== normalized(priorBuffers.get(path)!))) {
        conflicts.set(path, {path, disk:current.text, editors:[...buffers]});
        throw new PreconditionConflict(`编辑器中有尚未保存的更改：${path}。请先核对并保存。`, conflicts.get(path));
      }
    }
  };
  const alias = (path: string): boolean => caseOnly && (expected.get(move!.to)!.text === null ? path === move!.to : path === move!.from);
  const check = async (path: string): Promise<void> => {
    if (alias(path)) return;
    const current = expected.get(path)!;
    const observed = version(await tree.source(join(root,path)));
    if (observed.digest !== current.digest) {
      conflicts.set(path, {path, disk:observed.text, editors:[...host.buffers?.(vaultPath(path)) ?? []]});
      throw new Error(`文件已被其他程序更改：${path}`);
    }
    checkBuffers(path, current);
  };
  for (const [path, current] of expected) if (!alias(path)) checkBuffers(path, current);
  if (!files.length) return readResult();

  const journal = await newJournal(tree, root);
  await tree.file(join(journal, "journal.json"), JSON.stringify({
    expectedRevision: base?.revision ?? null, move, files,
    expected: Object.fromEntries([...expected].map(([path, v]: [string, Version]): [string, string | null] => [path, v.digest])),
  }, null, 2));
  await tree.sync(journal);
  let result: ProjectSnapshot;
  const published = new Map<string, () => void>();
  let openMove: OpenChapterMove | undefined;
  try {
    for (const [index, file] of files.entries()) {
      if (move && file.path === move.to) continue;
      const target = join(root, file.path);
      await tree.directories(join(root, dirname(file.path)));
      const staged = join(journal, `file-${index}`);
      let checkMetadata: ((path: string) => void) | undefined;
      if (!move || file.path !== move.from) {
        if (file.afterText !== null) {
          await tree.file(staged, file.afterText, file.beforeDigest === null ? 0o644 : tree.mode(target));
        }
      }
      if (file.beforeText !== null && file.afterText !== null) checkMetadata = tree.copyMetadata(target, staged, false);
      // Recheck all unchanged dependencies, including unrelated project members and split panes.
      for (const path of expected.keys()) await check(path);
      if (move && file.path === move.from) {
        await tree.directories(join(root, dirname(move.to)));
        await check(move.to);
        await check(move.from);
        if (!host.prepareRename) throw new Error("无法连接 Obsidian 章节窗格。");
        const moved = join(journal, "moved.md");
        const destination = join(root, move.to);
        // Exercise both primitives on this volume before moving any manuscript.
        const probeA = join(journal, "probe-a"), probeB = join(journal, "probe-b");
        await tree.file(probeA, "");
        await atomicFiles.publish(probeA, probeB, tree);
        await tree.file(probeA, "");
        await atomicFiles.replace(probeA, probeB, tree);
        // Cross-device staging/publication cannot use either atomic primitive.
        tree.sameVolume(dirname(target), dirname(destination), journal, root);
        openMove = await host.prepareRename(vaultPath(move.from));
        await check(move.from);
        await check(move.to);
        const mode = tree.mode(target);
        await atomicFiles.stage(target, moved, tree);
        await tree.sync(journal);
        try {
          const source = await tree.source(moved);
          if (source?.digest !== file.beforeDigest) throw new Error("移动时原文件已更改，已保留外部内容。");
          await tree.file(staged, source!.text, mode);
          tree.copyMetadata(moved, staged, true)(moved);
          published.set(move.to, tree.publicationSignal(staged,destination));
          await atomicFiles.publish(staged, destination, tree);
        } catch (error: unknown) {
          try {
            const restore = join(journal, "restore.md");
            const source = await tree.source(moved);
            if (source) {
              await tree.file(restore, source.text, mode);
              tree.copyMetadata(moved, restore, true)(moved);
              await atomicFiles.publish(restore, target, tree);
              await tree.sync(dirname(target));
              await openMove.reconnect(vaultPath(move.from));
            }
          } catch { /* Competing source and old inode remain inspectable. */ }
          throw error;
        }
        await tree.sync(dirname(destination));
        expected.set(move.to, fromText(file.beforeText));
      } else if (file.beforeText === null && file.afterText !== null) {
        if (/\.md$/i.test(file.path)) published.set(file.path, tree.publicationSignal(staged,target));
        await atomicFiles.publish(staged, target, tree); // Exclusive creation and a single visible filesystem event.
      } else if (file.beforeText !== null) {
        if (file.afterText === null) tree.rename(target, staged, "publish");
        else {
          checkMetadata?.(target);
          await atomicFiles.replace(staged, target, tree);
          checkMetadata?.(staged);
        }
        // The displaced file survives even if another editor replaced it during the syscall.
        if ((await tree.source(staged))?.digest !== file.beforeDigest) {
          throw new Error(`替换时发现外部更改，已保留移出的文件：${file.path}`);
        }
      }
      await tree.sync(dirname(target));
      await tree.sync(journal);
      expected.set(file.path, fromText(file.afterText));
      priorBuffers.set(file.path, file.beforeText);
    }
    for (const [path, signal] of published) await host.ensureIndexed?.(vaultPath(path),signal);
    if (move && openMove) await openMove.reconnect(vaultPath(move.to));
    result = await readResult();
    const actual = new Map(result.files.map((file: SourceFile): [string, string] => [file.path, file.digest]));
    for (const path of projectMembers(config)) {
      if ((actual.get(path) ?? null) !== expected.get(path)?.digest) {
        const disk = result.files.find((file: SourceFile): boolean => file.path === path)?.text ?? null;
        conflicts.set(path, {path, disk, editors:[...host.buffers?.(vaultPath(path)) ?? []]});
        throw new Error(`读取结果时文件已更改：${path}`);
      }
    }
    for (const path of expected.keys()) await check(path);
    // Reconnection and the final disk checks can yield to editor-change. Close
    // the capture window synchronously before the first completion-marker write.
    if (openMove?.drafts?.().length) throw new Error("移动期间编辑器收到新内容，已保留恢复记录。");
    openMove?.dispose?.();
    openMove = undefined;
    await tree.file(join(journal, "complete"), "ok\n");
    await tree.sync(journal);
  } catch (error: unknown) {
    const capturedDrafts = [...openMove?.drafts?.() ?? []];
    openMove?.dispose?.();
    const observed: ObservedVersion[] = [];
    for (const path of expected.keys()) {
      const current = await tree.source(join(root, path)).catch((): undefined => undefined);
      const saved = conflicts.get(path);
      const buffers = [...host.buffers?.(vaultPath(path)) ?? [], ...(path === move?.from ? capturedDrafts : [])];
      if (saved && saved.disk === (current?.text ?? null)) {
        observed.push({...saved, editors: [...new Set([...saved.editors, ...buffers])]});
        continue;
      }
      if (saved) observed.push(saved);
      if (saved || files.some((f: JournalFile): boolean => f.path === path) || current?.digest !== (expected.get(path)?.digest ?? undefined) ||
          buffers.some((text: string): boolean => normalized(text) !== normalized(current?.text ?? null))) {
        observed.push({ path, disk: current?.text ?? null, editors: buffers });
      }
    }
    await tree.file(join(journal, "observed.json"), JSON.stringify(observed, null, 2));
    await tree.sync(journal);
    throw new Error(`${writeFailure(error)}（已保留恢复记录）`, { cause: error });
  }
  // Retention also preserves writes through external old descriptors after completion.
  return result;
}
