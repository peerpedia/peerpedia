import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { MarkdownView, type App, type Editor } from "obsidian";

import { vaultPath } from "../project/path-identity";
import type { ChapterLanguage, ProjectAnalysis, WritingAnalysis } from "../language/analysis";
import { isManuscriptPath, pathKey } from "../project/paths";
import { CONFIG_PATH, projectMembers, projectRevision, sourceDigest, type ProjectEvent } from "../project/store";
import type { PaperConfig, ProjectSnapshot, SourceFile } from "../project/types";
import { LanguageWorker } from "./language-worker";
import { VaultProjectStore } from "./vault-store";

export interface WritingContext {
  project: ProjectSnapshot;
  analysis: ProjectAnalysis;
  chapter: ChapterLanguage;
}

interface ReadyContext {
  doc: Text;
  context: WritingContext;
}

interface ProjectEntry {
  readonly root: string;
  stop: () => void;
  read: Promise<ProjectSnapshot | null> | null;
  disk: ProjectSnapshot | null;
}

interface PendingEditor {
  view: EditorView;
  doc: Text;
  path: string;
  generation: number;
}

interface AnalysisBatch {
  project: ProjectSnapshot;
  editors: PendingEditor[];
}

export interface CompletionSnapshot {
  project: ProjectSnapshot;
  path: string;
}

const CHECK_DELAY_MS = 170;
const scratchConfig: PaperConfig = {
  title: "", authors: "", abstract: "", primary_category: "", secondary_categories: [], license: "",
};

export { vaultPath } from "../project/path-identity";

export function editorText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function editedSource(path: string, text: string): SourceFile {
  return { path, text, digest: sourceDigest(Buffer.from(text)) };
}

/** Overlay the native LF buffer only when it differs from the original disk text (which may be CRLF). */
export function withEditorSources(disk: ProjectSnapshot, read: (path: string) => string | undefined): ProjectSnapshot {
  const files = disk.files.map((file: SourceFile): SourceFile => {
    if (file.path === CONFIG_PATH || file.path === disk.config.bibliography) return file;
    const open = read(vaultPath(disk.root, file.path));
    return open !== undefined && open !== editorText(file.text) ? editedSource(file.path, open) : file;
  });
  return { ...disk, files, revision: projectRevision(files) };
}

export class WritingProjects {
  private readonly store: VaultProjectStore;
  private readonly worker = new LanguageWorker();
  private readonly roots = new Map<string, ProjectEntry>();
  private readonly editors = new Map<EditorView, string>();
  private readonly knownRoots = new Map<string, string | null>();
  private readonly contexts = new Map<EditorView, ReadyContext>();
  private readonly generations = new Map<string, number>();
  private readonly previous = new Map<string, WritingAnalysis>();
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private queued = false;
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
    this.contexts.delete(view);
    if (path === null) this.editors.delete(view);
    else this.editors.set(view, path);
    this.refreshRoots();
  }

  refreshRoots(): void {
    if (this.disposed) return;
    this.knownRoots.clear();
    this.previous.clear();
    this.generations.clear();
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
    const root = path === undefined ? null : this.rootFor(path);
    let related = false;
    for (const [view, editorPath] of this.editors) {
      if (path === undefined || path === editorPath || (root !== null && this.rootFor(editorPath) === root)) {
        this.contexts.delete(view);
        this.generations.set(editorPath, ++this.generation);
        related = true;
      }
    }
    if (!related) return;
    this.changed();
    clearTimeout(this.timer);
    this.timer = setTimeout((): void => { void this.rebuild(); }, CHECK_DELAY_MS);
  }

  current(view: EditorView): WritingContext | null {
    const ready = this.contexts.get(view);
    return ready?.doc === view.state.doc ? ready.context : null;
  }

  async completionSnapshot(path: string, source: string): Promise<CompletionSnapshot | null> {
    const entry = this.entryFor(path);
    while (entry?.read && this.entryFor(path) === entry) await entry.read;
    if (this.disposed || this.entryFor(path) !== entry) return null;
    return this.snapshotFor(path, source, entry?.disk ?? null, this.editorSources());
  }

  isCompletionCurrent(path: string, source: string, revision: string): boolean {
    const entry = this.entryFor(path);
    if (this.disposed || entry?.read) return false;
    return this.snapshotFor(path, source, entry?.disk ?? null, this.editorSources()).project.revision === revision;
  }

  async readCurrent(path: string, editor: Editor): Promise<WritingContext | null> {
    const entry = this.entryFor(path);
    const disk = entry ? await this.store.read(entry.root).catch((): null => null) : null;
    if (this.disposed || this.entryFor(path) !== entry) return null;
    const generation = this.generations.get(path);
    const source = editor.getValue();
    const snapshot = this.snapshotFor(path, source, disk, this.editorSources());
    const result = this.cached(snapshot) ?? await this.worker.run("analyze", snapshot.project);
    if (this.disposed || this.generations.get(path) !== generation || editor.getValue() !== source) return null;
    return this.context(snapshot, result);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.worker.dispose();
    for (const entry of this.roots.values()) entry.stop();
    this.roots.clear();
    this.editors.clear();
    this.contexts.clear();
    this.knownRoots.clear();
    this.generations.clear();
    this.previous.clear();
  }

  rootFor(path: string): string | null {
    if (this.knownRoots.has(path)) return this.knownRoots.get(path) ?? null;
    if (!isManuscriptPath(path)) return null;
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
    const entry: ProjectEntry = { root, stop: (): void => {}, disk: null, read: null };
    this.roots.set(root, entry);
    entry.stop = this.store.watch(root, (_event: ProjectEvent): void => this.load(entry));
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
      this.invalidate(vaultPath(entry.root, CONFIG_PATH));
    });
  }

  private editorSources(): ReadonlyMap<string, Editor> {
    const buffers = new Map<string, Editor>();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView && leaf.view.file && leaf.view.editor) {
        buffers.set(pathKey(leaf.view.file.path), leaf.view.editor);
      }
    }
    return buffers;
  }

  private snapshotFor(
    path: string, source: string, disk: ProjectSnapshot | null, buffers: ReadonlyMap<string, Editor>,
  ): CompletionSnapshot {
    const current = pathKey(path);
    const member = disk && projectMembers(disk.config).slice(1).find((item: string): boolean =>
      pathKey(vaultPath(disk.root, item)) === current);
    if (disk && member) {
      const project = withEditorSources(disk, (file: string): string | undefined =>
        pathKey(file) === current ? source : buffers.get(pathKey(file))?.getValue());
      return { path: member, project };
    }
    // Scope and membership are independent. An enabled note has its own
    // index unless it is a declared member of the paper.
    const file = editedSource(path, source);
    return {
      path,
      project: {
        root: "", config: { ...scratchConfig, chapters: [{ id: "note", title: "", file: path }] },
        files: [file], revision: projectRevision([file]),
      },
    };
  }

  private context(snapshot: CompletionSnapshot, result: WritingAnalysis): WritingContext | null {
    const chapter = result.chapters.get(snapshot.path);
    return chapter ? { project: snapshot.project, analysis: result.analysis, chapter } : null;
  }

  private cacheKey(project: ProjectSnapshot): string {
    return project.files.some((file: SourceFile): boolean => file.path === CONFIG_PATH)
      ? `project:${project.root}` : `note:${project.files[0]?.path}`;
  }

  private cached({ project }: CompletionSnapshot): WritingAnalysis | undefined {
    const result = this.previous.get(this.cacheKey(project));
    return result?.analysis.revision === project.revision ? result : undefined;
  }

  private isLatest(editor: PendingEditor): boolean {
    return !this.disposed && this.editors.get(editor.view) === editor.path && editor.view.state.doc === editor.doc
      && this.generations.get(editor.path) === editor.generation && !editor.view.compositionStarted;
  }

  private batches(): AnalysisBatch[] {
    const batches = new Map<string, AnalysisBatch>();
    const buffers = this.editorSources();
    for (const [view, path] of this.editors) {
      const doc = view.state.doc;
      const generation = this.generations.get(path);
      if (generation === undefined || view.compositionStarted || this.current(view)) continue;
      const entry = this.entryFor(path);
      if (entry?.read) continue;
      const { project } = this.snapshotFor(path, doc.toString(), entry?.disk ?? null, buffers);
      const key = `${this.cacheKey(project)}:${project.revision}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = { project, editors: [] };
        batches.set(key, batch);
      }
      batch.editors.push({ view, doc, path, generation });
    }
    return [...batches.values()];
  }

  private async rebuild(): Promise<void> {
    this.timer = undefined;
    if (this.running) {
      this.queued = true;
      return;
    }
    this.running = true;
    try {
      for (const { project, editors } of this.batches()) {
        if (!editors.some((editor: PendingEditor): boolean => this.isLatest(editor))) continue;
        const key = this.cacheKey(project);
        const cached = this.previous.get(key);
        const result = cached?.analysis.revision === project.revision ? cached
          : await this.worker.run("analyze", project);
        if (result.analysis.revision !== project.revision) continue;
        for (const editor of editors) {
          if (!this.isLatest(editor)) continue;
          const path = project.files.find((file: SourceFile): boolean =>
            pathKey(vaultPath(project.root, file.path)) === pathKey(editor.path))?.path;
          const context = path ? this.context({ project, path }, result) : null;
          if (context) {
            this.previous.set(key, result);
            this.contexts.set(editor.view, { doc: editor.doc, context });
            this.changed();
          }
        }
      }
    } catch {
      // The next edit or disk change starts a fresh worker after a crash.
    } finally {
      this.running = false;
      if (this.queued && !this.disposed && this.timer === undefined) {
        this.queued = false;
        void this.rebuild();
      } else this.queued = false;
    }
  }
}
