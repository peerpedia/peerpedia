import { setTimeout, clearTimeout } from "node:timers";
import { UserFacingError } from "../user-error";
import { realpathSync, statSync, type BigIntStats, watch as watchFiles, type Dirent, type FSWatcher } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { TAbstractFile, Vault } from "obsidian";

import { isMissing, isManuscriptPath, locatePath, pathKey } from "../project/paths";
import {
  CONFIG_PATH, parsePaperConfig, projectMembers, projectRevision, sourceDigest, type FileChange,
  type ProjectEvent, type ProjectStore, type MergeCommit,
} from "../project/store";
import { ProjectReadError, type ChapterSpec, type ProjectSnapshot, type SourceFile } from "../project/types";

import { AnchoredFiles, withAnchors } from "../project/anchored-files";
import { readSource } from "../project/source-file";
import { keepConflict, newJournal, PreconditionConflict, safePath, writeTransaction, type WriteHost } from "../project/transaction";
import { recoverIn, inspectRecovery, type RecoveryFile, type RecoveryNotice } from "../project/recovery";

import { finishImport, prepareImport, readPendingImport, readProposalBase, readVersion, writeVersion, type BindingVersion } from "../remote/binding";
import { SubmissionJournal } from "../remote/journal";
import { finishMerge, stageMerge } from "../remote/merge-journal";
import { importChanges } from "../remote/import";
import type { RemoteBinding, VerifiedSnapshot } from "../remote/types";

const WATCH_SETTLE_MS = 30;

function checkRoot(root: string): void {
  if (root && !isManuscriptPath(root)) {
    throw new ProjectReadError(CONFIG_PATH, `Unsafe project root "${root}". Use a path within the vault.`);
  }
}

function isManifest(entry: Dirent): boolean {
  return pathKey(entry.name) === CONFIG_PATH && (entry.isFile() || entry.isSymbolicLink());
}

async function rejectNestedProject(base: string, root: string, absolute: string, configDir?: string): Promise<void> {
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
      if (entry.isDirectory() && isManuscriptPath(join(root, folder, entry.name), configDir)) {
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
  private vaultIdentity?: BigIntStats;

  constructor(basePath: string, private readonly vault: Pick<Vault, "on" | "offref"> & Partial<Pick<Vault, "configDir">>,
    private readonly host: WriteHost = {}) {
    this.basePath = resolve(basePath);
    try {
      this.basePath = realpathSync(basePath);
      this.vaultIdentity = statSync(this.basePath, {bigint:true});
    } catch (error: unknown) { if (!isMissing(error)) throw error; }
  }

  private checkPaths(root: string, paths: readonly string[] = []): void {
    checkRoot(root);
    const config = this.vault.configDir && pathKey(this.vault.configDir);
    for (const path of [root, ...paths.map((path: string): string => root ? root + "/" + path : path)]) {
      const key = pathKey(path);
      if (config && (key === config || key.startsWith(config + "/"))) throw new UserFacingError("Paper files must stay outside the vault configuration directory.");
    }
  }

  async read(root: string): Promise<ProjectSnapshot> {
    this.checkPaths(root);
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
    await rejectNestedProject(base, root, absolute, this.vault.configDir);
    const config = parsePaperConfig(metadata.text);
    this.checkPaths(root, projectMembers(config));
    const files = [metadata];
    for (const path of projectMembers(config).slice(1)) {
      const file = await readSource(absolute, path, identities);
      if (file) files.push(file);
    }
    return { root, config, files, revision: projectRevision(files) };
  }

  private async directory(root: string): Promise<string> {
    this.checkPaths(root);
    const base = await realpath(this.basePath);
    if (!root) return base;
    const dir = await locatePath(base, root, CONFIG_PATH);
    if (!dir?.stat.isDirectory()) throw new UserFacingError("The paper folder does not exist.");
    return dir.absolute;
  }

  async localPath(root: string, path: string): Promise<string> {
    this.checkPaths(root, [path]);
    const found = await locatePath(await this.directory(root), path, path);
    if (!found) throw new UserFacingError("The source file was not found.");
    return found.absolute;
  }

  async recordNativeConflict(root: string, path: string, drafts: readonly {base: string; local: string}[],
    observed: (disk: string) => void): Promise<RecoveryNotice | undefined> {
    safePath(path);
    this.checkPaths(root, [path]);
    return this.anchored(root, async (tree: AnchoredFiles): Promise<RecoveryNotice | undefined> => {
      // Start the descriptor-pinned read before the native view can merge or autosave the external text.
      const external = await tree.source(join(root, path));
      if (!external) return;
      observed(external.text);
      const normalized = (value: string): string => value.replace(/\r\n/g, "\n");
      const disk = normalized(external.text);
      const divergent = drafts.filter(({base, local}: {base: string; local: string}): boolean =>
        normalized(base) !== normalized(local) && normalized(base) !== disk && normalized(local) !== disk);
      if (!divergent.length) return;
      const manifest = await tree.source(join(root, CONFIG_PATH));
      if (!manifest) return;
      const config = parsePaperConfig(manifest.text);
      const members = projectMembers(config).slice(1).filter((name: string): boolean => name !== config.bibliography);
      const member = members.find((name: string): boolean => name.normalize() === path.normalize());
      if (!member) return;
      await rejectNestedProject(this.basePath, root, join(this.basePath, root));
      // One durable record per distinct pane draft, even if their bases differ.
      let notice: RecoveryNotice | undefined;
      for (const {base, local} of divergent) {
        const dir = await newJournal(tree, root);
        const files = [{path: member, beforeDigest: sourceDigest(Buffer.from(base)), beforeText: base,
          afterText: local, externalText: external.text}];
        await tree.file(join(dir, "journal.json"), JSON.stringify({kind: "native-conflict", files}));
        await tree.sync(dir);
        notice = {transactionId: basename(dir), paths: [member], message: "The original, editor draft, and external changes were saved."};
      }
      return notice;
    });
  }

  async recoveryFiles(root: string, id: string): Promise<readonly RecoveryFile[]> {
    return this.anchored(root,(tree: AnchoredFiles): Promise<readonly RecoveryFile[]> => inspectRecovery(tree,root,id));
  }

  async recovery(root: string): Promise<readonly RecoveryNotice[]> {
    return this.anchored(root,(tree: AnchoredFiles): Promise<readonly RecoveryNotice[]> => recoverIn(tree,root));
  }

  async member(root: string, path: string): Promise<SourceFile | undefined> {
    safePath(path);
    this.checkPaths(root, [path]);
    return this.anchored(root, async (tree: AnchoredFiles): Promise<SourceFile | undefined> => {
      const file = await tree.source(join(root,path));
      return file ? {...file,path} : undefined;
    });
  }

  private anchored<T>(root: string, action: (tree: AnchoredFiles) => Promise<T>): Promise<T> {
    this.checkPaths(root);
    if (root) safePath(root);
    return withAnchors(this.basePath, async (tree: AnchoredFiles): Promise<T> => {
      this.vaultIdentity ??= statSync(this.basePath, {bigint:true});
      tree.checkRoot(this.vaultIdentity);
      return action(tree);
    }, this.vault.configDir);
  }

  private async pinnedSnapshot(tree: AnchoredFiles, root: string): Promise<ProjectSnapshot> {
    const identities = new Map<string,string>();
    const manifest = await tree.source(join(root,CONFIG_PATH),identities);
    if (!manifest) throw new UserFacingError("The paper is missing paper.json.");
    const config = parsePaperConfig(manifest.text);
    this.checkPaths(root, projectMembers(config));
    const files = [{...manifest, path:CONFIG_PATH}];
    for (const path of projectMembers(config).slice(1)) {
      safePath(path);
      const file = await tree.source(join(root,path),identities);
      if (file) files.push({...file,path});
    }
    return {root,config,files,revision:projectRevision(files)};
  }

  private async exclusive(root: string, operation: () => Promise<ProjectSnapshot>): Promise<ProjectSnapshot> {
    const key = pathKey(join(this.basePath, root));
    if (writes.has(key)) throw new UserFacingError("This paper is being saved. Try again shortly.");
    const pending = operation();
    writes.set(key, pending);
    try { return await pending; } finally { writes.delete(key); }
  }

  readonly submissions = new SubmissionJournal(<T>(root: string, action: (tree: AnchoredFiles, readCurrent: ()=>Promise<ProjectSnapshot>)=>Promise<T>): Promise<T> =>
    this.anchored(root,async (tree: AnchoredFiles): Promise<T> => {
      tree.lockProject(root);
      return action(tree,async (): Promise<ProjectSnapshot> => {
        const project = await this.pinnedSnapshot(tree,root);
        return writeTransaction(tree,root,project,[],this.host,(): Promise<ProjectSnapshot> => this.pinnedSnapshot(tree,root));
      });
    }));

  async readBindingVersion(root: string): Promise<BindingVersion> {
    return this.anchored(root, (tree: AnchoredFiles): Promise<BindingVersion> => readVersion(tree,root));
  }

  async readProposalBase(root: string, proposalId: string, digest: string): Promise<VerifiedSnapshot|null> {
    return this.anchored(root,(tree: AnchoredFiles): Promise<VerifiedSnapshot|null> => readProposalBase(tree,root,proposalId,digest));
  }

  async loadBinding(root: string): Promise<RemoteBinding | null> {
    return (await this.readBindingVersion(root)).binding;
  }

  async saveBinding(root: string, binding: RemoteBinding, expectedDigest: string | null): Promise<void> {
    return this.anchored(root, (tree: AnchoredFiles): Promise<void> => writeVersion(tree,root,binding,expectedDigest));
  }

  async recoverImport(root: string): Promise<void> {
    await this.exclusive(root, (): Promise<ProjectSnapshot> => this.anchored(root, async (tree: AnchoredFiles): Promise<ProjectSnapshot> => {
      tree.lockProject(root);
      const intent = await readPendingImport(tree,root);
      await rejectNestedProject(this.basePath,root,join(this.basePath,root),this.vault.configDir);
      const changes = importChanges(intent.binding.workingBase);
      this.checkPaths(root, changes.map((change: FileChange): string => change.path));
      for (const change of changes) {
        const existing = await tree.source(join(root,change.path));
        if (!existing) continue;
        if (existing.text !== change.afterText) throw new UserFacingError(`The imported file changed. Check "${change.path}".`);
        change.beforeDigest = existing.digest;
      }
      // The transaction rechecks every observed digest and open buffer. Equal members
      // are dependencies only. Missing ones use exclusive publication, manifest last.
      const project = await writeTransaction(tree,root,null,changes,this.host,(): Promise<ProjectSnapshot> => this.pinnedSnapshot(tree,root));
      await finishImport(tree,root,project.revision,intent.binding);
      return project;
    }));
  }

  create(root: string, changes: readonly FileChange[], initialBinding?: RemoteBinding): Promise<ProjectSnapshot> {
    return this.exclusive(root, async (): Promise<ProjectSnapshot> => {
      safePath(root);
      if (changes.some((change: FileChange): boolean => change.beforeDigest !== null || change.afterText === null)) {
        throw new UserFacingError("A new paper can only create new files.");
      }
      const config = parsePaperConfig(changes.find((change: FileChange): boolean => change.path === CONFIG_PATH)?.afterText ?? "");
      const members = projectMembers(config);
      this.checkPaths(root, members);
      const keys = new Set<string>();
      for (const member of members) safePath(member);
      for (const change of changes) {
        safePath(change.path);
        const key = pathKey(change.path);
        if (!members.includes(change.path) || keys.has(key)) throw new UserFacingError("There is a duplicate path or a file outside the paper.");
        keys.add(key);
      }
      return this.anchored(root,async (tree: AnchoredFiles): Promise<ProjectSnapshot> => {
        const parent = dirname(root);
        if (tree.list(parent).some((name: string): boolean => pathKey(name) === pathKey(basename(root)))) {
          throw new UserFacingError("The destination folder already exists. Choose a different name.");
        }
        for (let ancestor = parent;; ancestor = dirname(ancestor)) {
          if (tree.list(ancestor).some((name: string): boolean => pathKey(name) === CONFIG_PATH)) {
            throw new UserFacingError("Create the new paper outside existing paper folders.");
          }
          if (ancestor === ".") break;
        }
        await tree.mkdir(root);
        if (initialBinding) {
          tree.lockProject(root);
          const files = changes.map((change: FileChange): SourceFile => ({
            path:change.path, text:change.afterText!, digest:sourceDigest(Buffer.from(change.afterText!)),
          }));
          await prepareImport(tree,root,initialBinding,projectRevision(files));
        }
        try {
          const project = await writeTransaction(tree,root,null,changes,this.host,(): Promise<ProjectSnapshot> => this.pinnedSnapshot(tree,root));
          if (initialBinding) await finishImport(tree,root,project.revision,initialBinding);
          return project;
        } catch (error: unknown) {
          if (!initialBinding) throw error;
          throw new UserFacingError("The import did not finish. Open this folder in the paper panel to finish the binding.", {cause:error});
        }
      });
    });
  }

  async recoverMerge(root: string): Promise<void> {
    await this.exclusive(root, (): Promise<ProjectSnapshot> => this.anchored(root, async (tree: AnchoredFiles): Promise<ProjectSnapshot> => {
      tree.lockProject(root);
      await rejectNestedProject(this.basePath,root,join(this.basePath,root),this.vault.configDir);
      const read = (): Promise<ProjectSnapshot> => this.pinnedSnapshot(tree,root);
      const project = await read();
      const checked = await writeTransaction(tree,root,project,[],this.host,read);
      await finishMerge(tree,root,checked.revision,true);
      return checked;
    }));
  }

  apply(root: string, expectedRevision: string, changes: readonly FileChange[], merge?: MergeCommit): Promise<ProjectSnapshot> {
    return this.save(root, expectedRevision, changes, undefined, merge);
  }

  renameChapter(project: ProjectSnapshot, id: string, to: string): Promise<ProjectSnapshot> {
    const chapters = project.config.chapters ?? [];
    const chapter = chapters.find((item: ChapterSpec): boolean => item.id === id);
    const source = project.files.find((file: SourceFile): boolean => file.path === chapter?.file);
    if (!chapter || !source) return Promise.reject(new UserFacingError("The chapter source file was not found."));
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
    move?: { from: string; to: string }, merge?: MergeCommit): Promise<ProjectSnapshot> {
    return this.exclusive(root, async (): Promise<ProjectSnapshot> => {
      this.checkPaths(root, changes.map((change: FileChange): string => change.path));
      return this.anchored(root,async (tree: AnchoredFiles): Promise<ProjectSnapshot> => {
        if (merge) tree.lockProject(root);
        else tree.directory(root);
        await rejectNestedProject(this.basePath, root, join(this.basePath,root),this.vault.configDir);
        const project = await this.pinnedSnapshot(tree,root);
        try {
          if (project.revision !== expectedRevision) throw new PreconditionConflict("The paper changed elsewhere. Reload it and review the changes.");
          let transaction: string|undefined;
          const prepare = merge ? async (journal: string): Promise<string> => {
            const digest = await stageMerge(tree,root,journal,expectedRevision,merge);
            transaction = basename(journal);
            return digest;
          } : undefined;
          const result = await writeTransaction(tree,root,project,changes,this.host,(): Promise<ProjectSnapshot> => this.pinnedSnapshot(tree,root),move,prepare);
          if (merge) await finishMerge(tree,root,(await this.pinnedSnapshot(tree,root)).revision,false,transaction);
          return result;
        } catch (error: unknown) {
          if (error instanceof PreconditionConflict) await keepConflict(tree, project, expectedRevision, changes, this.host, error.observed);
          throw error;
        }
      });
    });
  }

  watch(root: string, listener: (event: ProjectEvent) => void): () => void {
    this.checkPaths(root);
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
