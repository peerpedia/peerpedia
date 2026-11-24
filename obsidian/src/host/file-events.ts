import { UserFacingError } from "../user-error";
import type { App, Editor, EditorSelection, MarkdownView, TFile, ViewState, WorkspaceLeaf } from "obsidian";
import type { OpenChapterMove } from "../project/transaction";
import type { WritingScope } from "../main";
import { locatePath, pathKey } from "../project/paths";

export function openBuffers(app: App, path: string): readonly string[] {
  const key = pathKey(path);
  const buffers: string[] = [];
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as MarkdownView;
    if (view.file && view.editor && pathKey(view.file.path) === key) {
      buffers.push(view.editor.getValue());
    }
  }
  return buffers;
}

export function moveScope(scope: WritingScope, oldPath: string, newPath: string): WritingScope {
  oldPath = oldPath.normalize();
  newPath = newPath.normalize();
  const moved = (rules: Readonly<Record<string, boolean>>): Record<string, boolean> => {
    const next = { ...rules };
    for (const [path, enabled] of Object.entries(rules)) {
      if (path === oldPath || path.startsWith(oldPath + "/")) {
        delete next[path];
        next[newPath + path.slice(oldPath.length)] = enabled;
      }
    }
    return next;
  };
  return { folders: moved(scope.folders), files: moved(scope.files) };
}

export function isStagedMove(path: string): boolean {
  return /(?:^|\/)\.peerpedia-obsidian\/recovery\/[a-f0-9-]{36}\/moved\.md$/.test(path);
}

async function indexedFile(app: App, path: string): Promise<TFile> {
  const current = app.vault.getFileByPath(path);
  if (current) return current;
  // The exclusively published destination reaches Obsidian via its filesystem watcher.
  return new Promise<TFile>((resolve: (file: TFile) => void, reject: (reason: Error) => void): void => {
    const timer = setTimeout((): void => {
      app.vault.offref(ref);
      reject(new UserFacingError("The file was saved, but Obsidian has not found the new path. Reopen the chapter."));
    }, 3500);
    const check = (): void => {
      const file = app.vault.getFileByPath(path);
      if (!file) return;
      clearTimeout(timer);
      app.vault.offref(ref);
      resolve(file);
    };
    const ref = app.vault.on("create", check);
    check();
  });
}

export async function ensurePublishedFile(app: App, path: string, signal: () => void): Promise<void> {
  if (app.vault.getFileByPath(path)) return;
  // Desktop may install the enclosing folder's watcher after our first publication event.
  // Reannounce only the still-identical inode without touching the manuscript bytes or mtime.
  for (let attempt = 0; attempt < 6; ++attempt) {
    await new Promise<void>((resolve: () => void): void => { setTimeout(resolve, attempt ? 350 : 100); });
    if (app.vault.getFileByPath(path)) return;
    signal();
  }
  await indexedFile(app,path);
}

export async function stageChapter(app: App, from: string,
  moved: (from: string, to: string) => Promise<void>): Promise<OpenChapterMove> {
  const source = app.vault.getFileByPath(from);
  if (!source) throw new UserFacingError("Obsidian has not found the chapter file yet. Try again shortly.");
  const panes: { leaf: WorkspaceLeaf; view: MarkdownView; text: string; selections: EditorSelection[];
    scroll: {left: number; top: number}; state: ViewState }[] = [];
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view as MarkdownView;
    if (view.file !== source) continue;
    panes.push({ leaf, view, text: view.editor.getValue(), selections: view.editor.listSelections(),
      scroll: view.editor.getScrollInfo(), state: leaf.getViewState() });
  }
  const drafts = new Map<Editor,string>();
  const changes = app.workspace.on("editor-change",(editor: Editor): void => {
    const pane = panes.find((p: {view: MarkdownView}): boolean => p.view.editor === editor && p.view.file?.path === from);
    if (!pane) return;
    const text = editor.getValue();
    if (text === pane.text) drafts.delete(editor);
    else drafts.set(editor,text);
  });
  const checkDrafts = (): void => {
    if (drafts.size) throw new UserFacingError("The editor received new content during the move. A recovery record was saved.");
  };
  const reconnect = async (path: string): Promise<void> => {
    checkDrafts();
    if (path !== from) await moved(from, path);
    if (!panes.length) return;
    const target = await indexedFile(app, path);
    for (const pane of panes) {
      checkDrafts();
      const view = pane.leaf.view as MarkdownView;
      if (view !== pane.view && view.getViewType() !== "empty" && view.file?.path !== path) continue;
      if (view.file && view.file.path !== from && view.file.path !== path) continue;
      if (view === pane.view && view.file) {
        const currentText = view.editor.getValue();
        if (currentText !== pane.text) {
          drafts.set(view.editor, currentText);
          checkDrafts();
        }
      }
      const leaves = new Set<WorkspaceLeaf>();
      app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf): void => { leaves.add(leaf); });
      const destination = leaves.has(pane.leaf) ? pane.leaf : app.workspace.getLeaf("split");
      await destination.openFile(target, { active: false, state: { ...pane.state.state, file: path } });
      await destination.loadIfDeferred();
      const current = destination.view as MarkdownView;
      if (current.file?.path !== path) throw new UserFacingError("Unable to open the new path in the original pane.");
      current.editor.setSelections(pane.selections);
      current.editor.scrollTo(pane.scroll.left, pane.scroll.top);
    }
    checkDrafts();
  };
  return {reconnect, drafts: (): readonly string[] => [...drafts.values()], dispose: (): void => app.workspace.offref(changes)};
}

/** External Finder moves arrive as create/delete pairs. Remember only configured
 * paths, and follow an inode only when the original name has actually vanished. */
export class ExternalScopeMoves {
  private readonly identities = new Map<string, string>();
  private generation = 0;

  constructor(private readonly base: string, private readonly scope: () => WritingScope,
    private readonly move: (from: string, to: string) => Promise<void>) {}

  private async identity(path: string): Promise<string | undefined> {
    try {
      const file = await locatePath(this.base, path, path);
      return file ? `${file.stat.dev}:${file.stat.ino}` : undefined;
    } catch { return undefined; }
  }

  async refresh(): Promise<void> {
    const version = ++this.generation;
    const current = this.scope();
    const paths = new Set([...Object.keys(current.folders), ...Object.keys(current.files)]);
    for (const path of this.identities.keys()) if (!paths.has(path)) this.identities.delete(path);
    for (const path of paths) {
      if (!path) continue;
      const id = await this.identity(path);
      if (version !== this.generation) return;
      if (id) this.identities.set(path, id);
    }
  }

  async changed(path: string, created: boolean): Promise<void> {
    if (path.split("/").includes(".peerpedia-obsidian")) return;
    const current = this.scope();
    path = path.normalize();
    const configured = Object.hasOwn(current.folders, path) || Object.hasOwn(current.files, path);
    if (!configured && (!created || !this.identities.size)) return;
    const id = await this.identity(path);
    if (!id) return;
    if (configured) { this.identities.set(path, id); return; }
    const candidates = [...this.identities].filter((pair: [string, string]): boolean => pair[1] === id);
    if (candidates.length !== 1) return;
    const [old] = candidates[0];
    if (await this.identity(old)) return;
    if (this.identities.get(old) !== id) return;
    await this.move(old, path);
  }
}
