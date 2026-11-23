import { existsSync } from "node:fs";
import { join } from "node:path";

import type { EditorView } from "@codemirror/view";
import { MarkdownView, type App, type Editor } from "obsidian";

import { analyzeProject, type ProjectAnalysis } from "../language/analysis";
import { scanBibliography, scanChapter, type LabelTarget } from "../language/index";
import { isRelativePath, pathKey } from "../project/paths";
import { CONFIG_PATH, projectMembers, projectRevision, sourceDigest, type ProjectEvent } from "../project/store";
import type { PaperConfig, ProjectSnapshot, SourceFile } from "../project/types";
import { VaultProjectStore } from "./vault-store";

export interface WritingContext {
  project: ProjectSnapshot;
  analysis: ProjectAnalysis;
  path: string;
  source: string;
}

interface ProjectEntry {
  readonly root: string;
  stop: () => void;
  read: Promise<ProjectSnapshot | null> | null;
  disk: ProjectSnapshot | null;
  analysis: ProjectAnalysis | null;
  labels: Map<string, { digest: string; targets: readonly LabelTarget[] }>;
}

const CHECK_DELAY_MS = 170;
const scratchConfig: PaperConfig = {
  title: "", authors: "", abstract: "", primary_category: "", secondary_categories: [], license: "",
};

export function vaultPath(root: string, path: string): string {
  return root ? `${root}/${path}` : path;
}

export function editorText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function editedSource(path: string, text: string): SourceFile {
  return { path, text, digest: sourceDigest(Buffer.from(text)) };
}

export class WritingProjects {
  private readonly store: VaultProjectStore;
  private readonly roots = new Map<string, ProjectEntry>();
  private readonly editors = new Map<EditorView, string>();
  private readonly knownRoots = new Map<string, string | null>();
  private readonly contexts = new Map<string, WritingContext>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly base: string,
    private readonly changed: () => void,
  ) {
    this.store = new VaultProjectStore(base, app.vault);
  }

  attach(view: EditorView, path: string | null): void {
    if (this.disposed || (this.editors.get(view) ?? null) === path) return;
    if (path === null) this.editors.delete(view);
    else this.editors.set(view, path);
    this.refreshRoots();
  }

  refreshRoots(): void {
    if (this.disposed) return;
    this.knownRoots.clear();
    const activeRoots = new Set<string>();
    for (const path of this.editors.values()) {
      const root = this.rootFor(path);
      if (root === null) continue;
      activeRoots.add(root);
      if (!this.roots.has(root)) this.watch(root);
    }
    for (const [root, entry] of this.roots) {
      if (activeRoots.has(root)) continue;
      this.roots.delete(root);
      entry.stop();
    }
    this.invalidate();
  }

  invalidate(path?: string): void {
    if (this.disposed) return;
    if (path !== undefined) {
      let related = false;
      for (const editorPath of this.editors.values()) {
        const root = this.rootFor(editorPath);
        if (path === editorPath || (root !== null && this.rootFor(path) === root)) {
          this.contexts.delete(editorPath);
          related = true;
        }
      }
      if (!related) return;
    } else this.contexts.clear();
    this.changed();
    clearTimeout(this.timer);
    this.timer = setTimeout((): void => this.rebuild(), CHECK_DELAY_MS);
  }

  current(path: string, source: string): WritingContext | null {
    const context = this.contexts.get(path);
    return context && editorText(context.source) === source ? context : null;
  }

  completionIndex(path: string, source: string): ProjectAnalysis & { path: string } {
    const context = this.current(path, source);
    if (context) return { ...context.analysis, path: context.path };
    const entry = this.entryFor(path);
    const editorSources = this.editorSources();
    const project = this.projectFor(path, source, entry?.disk ?? null, editorSources);
    const labels: LabelTarget[] = [];
    for (const file of project.files) {
      if (file.path === CONFIG_PATH) continue;
      const cached = entry?.labels.get(file.path);
      if (cached?.digest === file.digest) {
        labels.push(...cached.targets);
        continue;
      }
      const scan = file.path === project.config.bibliography ? scanBibliography : scanChapter;
      const targets = scan(file.text, file.path).labels;
      if (project.root === entry?.root) entry.labels.set(file.path, { digest: file.digest, targets });
      labels.push(...targets);
    }
    const member = project.files.find((file: SourceFile): boolean =>
      pathKey(vaultPath(project.root, file.path)) === pathKey(path));
    return { revision: project.revision, labels, diagnostics: [], path: member?.path ?? path };
  }

  async readCurrent(path: string, editor: Editor): Promise<WritingContext | null> {
    const entry = this.entryFor(path);
    const disk = entry ? await this.store.read(entry.root).catch((): null => null) : null;
    if (this.disposed || (entry && this.entryFor(path) !== entry)) return null;
    const source = editor.getValue();
    const project = this.projectFor(path, source, disk, this.editorSources());
    return this.context(project, path, entry);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const entry of this.roots.values()) entry.stop();
    this.roots.clear();
    this.editors.clear();
    this.contexts.clear();
    this.knownRoots.clear();
  }

  private rootFor(path: string): string | null {
    if (this.knownRoots.has(path)) return this.knownRoots.get(path) ?? null;
    if (!isRelativePath(path)) return null;
    let parent = path;
    while (parent) {
      parent = parent.slice(0, Math.max(0, parent.lastIndexOf("/")));
      if (existsSync(join(this.base, parent, CONFIG_PATH))) {
        this.knownRoots.set(path, parent);
        return parent;
      }
    }
    this.knownRoots.set(path, null);
    return null;
  }

  private entryFor(path: string): ProjectEntry | undefined {
    const root = this.rootFor(path);
    return root === null ? undefined : this.roots.get(root);
  }

  private watch(root: string): void {
    const entry: ProjectEntry = { root, stop: (): void => {}, disk: null, read: null, analysis: null, labels: new Map() };
    this.roots.set(root, entry);
    entry.stop = this.store.watch(root, (_event: ProjectEvent): void => {
      this.load(entry);
    });
    this.load(entry);
  }

  private load(entry: ProjectEntry): void {
    const pending = this.store.read(entry.root).catch((): null => null);
    entry.read = pending;
    entry.disk = null;
    this.invalidate(vaultPath(entry.root, CONFIG_PATH));
    void pending.then((disk: ProjectSnapshot | null): void => {
      if (this.roots.get(entry.root) !== entry || entry.read !== pending) return;
      entry.read = null;
      entry.disk = disk;
      const members = new Set(disk ? projectMembers(disk.config) : []);
      for (const path of entry.labels.keys()) if (!members.has(path)) entry.labels.delete(path);
      this.invalidate(vaultPath(entry.root, CONFIG_PATH));
    });
  }

  private editorSources(): ReadonlyMap<string, string> {
    const buffers = new Map<string, string>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file && leaf.view.editor) {
        buffers.set(pathKey(leaf.view.file.path), leaf.view.editor.getValue());
      }
    }
    return buffers;
  }

  private projectFor(
    path: string, source: string, disk: ProjectSnapshot | null, buffers: ReadonlyMap<string, string>,
  ): ProjectSnapshot {
    if (disk && projectMembers(disk.config).slice(1).some((member: string): boolean =>
      pathKey(vaultPath(disk.root, member)) === pathKey(path))) {
      const current = pathKey(path);
      const files = disk.files.map((file: SourceFile): SourceFile => {
        if (file.path === CONFIG_PATH || file.path === disk.config.bibliography) return file;
        const key = pathKey(vaultPath(disk.root, file.path));
        const open = key === current ? source : buffers.get(key);
        return open !== undefined && open !== editorText(file.text) ? editedSource(file.path, open) : file;
      });
      return { ...disk, files, revision: projectRevision(files) };
    }
    // Scope and membership are independent: an enabled note can use BananaMark
    // locally without picking up the labels of a paper it does not belong to.
    const file = editedSource(path, source);
    return {
      root: "", config: { ...scratchConfig, chapters: [{ id: "note", title: "", file: path }] },
      files: [file], revision: projectRevision([file]),
    };
  }

  private context(project: ProjectSnapshot, path: string, entry: ProjectEntry | undefined): WritingContext | null {
    const file = project.files.find((item: SourceFile): boolean =>
      pathKey(vaultPath(project.root, item.path)) === pathKey(path));
    if (!file) return null;
    const cached = entry?.analysis;
    const analysis = cached?.revision === project.revision ? cached : analyzeProject(project);
    if (entry && project.root === entry.root) entry.analysis = analysis;
    return { project, analysis, path: file.path, source: file.text };
  }

  private rebuild(): void {
    this.timer = undefined;
    const buffers = this.editorSources();
    for (const [view, path] of this.editors) {
      if (view.compositionStarted) continue;
      const entry = this.entryFor(path);
      if (entry?.read) continue;
      const source = view.state.doc.toString();
      const project = this.projectFor(path, source, entry?.disk ?? null, buffers);
      const context = this.context(project, path, entry);
      if (context) this.contexts.set(path, context);
    }
    this.changed();
  }
}
