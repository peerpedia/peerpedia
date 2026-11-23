import type { Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, FileSystemAdapter, MarkdownView, Notice, Plugin, type Editor, type MarkdownFileInfo, type TAbstractFile, type WorkspaceLeaf } from "obsidian";

import { ensurePublishedFile, ExternalScopeMoves, isStagedMove, moveScope, openBuffers, stageChapter } from "./host/file-events";
import type { OpenChapterMove } from "./project/transaction";
import { VaultProjectStore } from "./host/vault-store";
import { PROJECT_PANEL, ProjectPanel } from "./ui/project-panel";
import { PREVIEW_VIEW, PreviewView } from "./ui/preview-view";
import { ScopeSettings } from "./ui/scope-settings";
import { errorMessage } from "./ui/conflict-modal";
import { WritingEditors } from "./host/editor-extension";
import { BIBLIOGRAPHY_SOURCE_VIEW, BibliographySourceView, openSourceTarget, warnNavigationFailure } from "./host/source-navigation";
import { BananaMarkSuggest } from "./host/suggest";
import { WritingProjects } from "./host/writing-projects";
import type { Reference } from "./language/index";
import { findTarget } from "./language/targets";
import { resolveScope } from "./project/scope";
import type { RecoveryNotice } from "./project/recovery";
import { CONFIG_PATH } from "./project/store";

export interface WritingScope {
  folders: Readonly<Record<string, boolean>>;
  files: Readonly<Record<string, boolean>>;
}

function scopeRules(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry: [string, unknown]): entry is [string, boolean] => typeof entry[1] === "boolean",
  ).map(([path, enabled]: [string, boolean]): [string, boolean] => [path.normalize(), enabled]));
}

export default class PeerpediaPlugin extends Plugin {
  writingScope: WritingScope = { folders: {}, files: {} };
  private scopeMoves?: ExternalScopeMoves;
  private settingsWrite: Promise<void> = Promise.resolve();
  projectStore?: VaultProjectStore;
  private writingEditors: WritingEditors | undefined;
  private writingProjects: WritingProjects | undefined;

  override async onload(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const settings: { writingScope?: Partial<WritingScope> } | null = await this.loadData();
    this.writingScope = {
      folders: scopeRules(settings?.writingScope?.folders),
      files: scopeRules(settings?.writingScope?.files),
    };
    const store = new VaultProjectStore(adapter.getBasePath(), this.app.vault, {
      buffers: (path: string): readonly string[] => openBuffers(this.app, path),
      ensureIndexed: (path: string, signal: () => void): Promise<void> => ensurePublishedFile(this.app,path,signal),
      prepareRename: (from: string): Promise<OpenChapterMove> =>
        stageChapter(this.app, from, (oldPath: string, path: string): Promise<void> => this.moveRules(oldPath, path)),
    });
    this.projectStore = store;
    const moves = new ExternalScopeMoves(adapter.getBasePath(), (): WritingScope => this.writingScope,
      (from: string, to: string): Promise<void> => this.moveRules(from, to));
    this.scopeMoves = moves;
    await moves.refresh();
    this.registerEvent(this.app.vault.on("create", (file: TAbstractFile): void => {
      void moves.changed(file.path, true).catch((error: unknown): void => { new Notice(errorMessage(error)); });
    }));
    this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile): void => {
      void moves.changed(file.path, false).catch((error: unknown): void => { new Notice(errorMessage(error)); });
    }));
    this.addSettingTab(new ScopeSettings(this.app, this));
    this.registerView(PROJECT_PANEL, (leaf: WorkspaceLeaf): ProjectPanel => new ProjectPanel(leaf, store,
      (root: string): Promise<void> => this.updateWritingScope({
        ...this.writingScope, folders: { ...this.writingScope.folders, [root]: true },
      })));
    const paperRoot = async (file: TAbstractFile | null): Promise<string | undefined> => {
      for (let parent = file?.parent; parent; parent = parent.parent) {
        const folder = parent.isRoot() ? "" : parent.path;
        if (await adapter.exists(folder ? folder + "/" + CONFIG_PATH : CONFIG_PATH)) return folder;
      }
      return undefined;
    };
    const openPanel = async (selectedRoot?: string): Promise<ProjectPanel> => {
      let leaf = this.app.workspace.getLeavesOfType(PROJECT_PANEL)[0];
      const root = selectedRoot ?? await paperRoot(this.app.workspace.getActiveFile());
      if (!leaf) {
        leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
        await leaf.setViewState({ type: PROJECT_PANEL, active: true, state: { root } });
      } else if (root !== undefined && leaf.view instanceof ProjectPanel) await leaf.view.selectRoot(root);
      await this.app.workspace.revealLeaf(leaf);
      if (!(leaf.view instanceof ProjectPanel)) throw new Error("无法打开论文管理面板。");
      return leaf.view;
    };
    const dir = this.manifest.dir ?? this.app.vault.configDir + "/plugins/" + this.manifest.id;
    this.registerView(PREVIEW_VIEW, (leaf: WorkspaceLeaf): PreviewView => new PreviewView(leaf, store, dir));
    this.addCommand({ id: "preview-paper", name: "打开论文预览", editorCallback: async (_editor: Editor, info: MarkdownView | MarkdownFileInfo): Promise<void> => {
      if (!(info instanceof MarkdownView)) return;
      const file = info.file;
      try {
        const root = await paperRoot(file);
        if (info.file !== file || !file) return;
        if (root === undefined) { new Notice("请在论文目录内打开章节。"); return; }
        let leaf = this.app.workspace.getLeavesOfType(PREVIEW_VIEW).find((item: WorkspaceLeaf): boolean =>
          item.getViewState().state?.root === root);
        if (!leaf) {
          leaf = this.app.workspace.createLeafBySplit(info.leaf, "vertical");
          await leaf.setViewState({ type: PREVIEW_VIEW, state: {root}, active: false });
        }
        await this.app.workspace.revealLeaf(leaf);
        if (leaf.view instanceof PreviewView) leaf.view.editorMoved(info.leaf, info.editor, file.path, true, true, true);
        this.app.workspace.setActiveLeaf(info.leaf, {focus: true});
      } catch (error: unknown) { new Notice(errorMessage(error)); }
    } });
    const notifyPreviews = (info: MarkdownView, changed: boolean, activated: boolean): void => {
      const path = info.file?.path;
      if (!path) return;
      for (const leaf of this.app.workspace.getLeavesOfType(PREVIEW_VIEW)) {
        if (leaf.view instanceof PreviewView) leaf.view.editorMoved(info.leaf, info.editor, path, changed,
          this.app.workspace.activeLeaf === info.leaf, activated);
      }
    };
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null): void => {
      if (leaf?.view instanceof MarkdownView) notifyPreviews(leaf.view, true, true);
    }));
    // Host consumers can update TextFileView.data before vault.modify is delivered.
    // Hold the immutable native document and its then-current base until disk acknowledges it.
    const pendingDrafts = new WeakMap<MarkdownView, {path: string; base: string; doc: Text}>();
    this.registerEditorExtension(EditorView.updateListener.of((update: ViewUpdate): void => {
      if (!update.docChanged && !update.selectionSet && !(update.focusChanged && update.view.hasFocus)) return;
      const info = update.state.field(editorInfoField, false);
      if (update.docChanged && info instanceof MarkdownView && info.file && this.writingProjects?.rootFor(info.file.path) != null) {
        const prior = pendingDrafts.get(info);
        const base = prior?.path === info.file.path && prior.doc === update.startState.doc ? prior.base : info.data;
        pendingDrafts.set(info, {path: info.file.path, base, doc: update.state.doc});
      }
      if (info instanceof MarkdownView) queueMicrotask((): void => notifyPreviews(info, update.docChanged, update.focusChanged && update.view.hasFocus));
    }));
    const showPanel = (create: boolean): void => {
      void openPanel().then((panel: ProjectPanel): void => { if (create) panel.createForm(); })
        .catch((error: unknown): void => { new Notice(errorMessage(error)); });
    };
    this.addCommand({ id: "manage-paper", name: "管理论文", callback: (): void => showPanel(false) });
    this.addCommand({ id: "create-paper", name: "新建论文", callback: (): void => showPanel(true) });
    this.addRibbonIcon("book-open", "管理论文", (): void => showPanel(false));
    this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, from: string): void => {
      if (isStagedMove(file.path)) return;
      void this.moveRules(from, file.path).catch((error: unknown): void => { new Notice(errorMessage(error)); });
    }));
    const editors = new WritingEditors((path: string): boolean =>
      resolveScope(path, this.writingScope.folders, this.writingScope.files));
    const projects = new WritingProjects(this.app, adapter.getBasePath(), (): void => editors.invalidate());
    this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile): void => {
      if (!/\.md$/i.test(file.path)) return;
      // Capture at the event boundary. Obsidian reads the new bytes asynchronously,
      // then may replace both its last-loaded data and the live source buffer.
      const drafts: {base: string; local: string}[] = [];
      const acknowledged: ((disk: string) => void)[] = [];
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || view.file !== file || view.getMode() !== "source") continue;
        const pending = pendingDrafts.get(view);
        const tracked = pending?.path === file.path ? pending : undefined;
        const base = tracked?.base ?? view.data, local = tracked?.doc.toString() ?? view.editor.getValue();
        if (base === local) { pendingDrafts.delete(view); continue; }
        if (tracked) acknowledged.push((disk: string): void => {
          if (disk.replace(/\r\n/g, "\n") === base.replace(/\r\n/g, "\n")) return;
          const current = pendingDrafts.get(view);
          if (current === tracked) pendingDrafts.delete(view);
          else if (current?.path === tracked.path && current.base === tracked.base) current.base = disk;
        });
        if (!drafts.some((draft: {base: string; local: string}): boolean => draft.base === base && draft.local === local)) {
          drafts.push({base, local});
        }
      }
      if (!drafts.length) return;
      const root = projects.rootFor(file.path);
      if (root === null) return;
      const member = root ? file.path.slice(root.length + 1) : file.path;
      const diskObserved = (disk: string): void => { for (const seen of acknowledged) seen(disk); };
      void store.recordNativeConflict(root, member, drafts, diskObserved).then((record: RecoveryNotice | undefined): void => {
        if (!record) return;
        const message = document.createDocumentFragment();
        message.createSpan({text: `「${member}」收到外部修改，已保留草稿。 `});
        message.createEl("button", {text: "核对版本"}).onclick = (): void => {
          void openPanel(root).then((panel: ProjectPanel): Promise<void> => panel.revealRecovery(root, record))
            .catch((error: unknown): void => { new Notice(errorMessage(error)); });
        };
        new Notice(message, 15000);
      }).catch((error: unknown): void => { new Notice(`无法保留草稿版本。${errorMessage(error)}`); });
    }));
    const suggest = new BananaMarkSuggest(
      this.app,
      (editor: Editor, path: string): ReturnType<WritingEditors["viewFor"]> => editors.viewFor(editor, path),
      projects,
    );
    this.writingEditors = editors;
    this.writingProjects = projects;
    this.register((): void => {
      suggest.dispose();
      projects.dispose();
      this.app.workspace.detachLeavesOfType(PREVIEW_VIEW);
      this.app.workspace.detachLeavesOfType(PROJECT_PANEL);
      this.app.workspace.detachLeavesOfType(BIBLIOGRAPHY_SOURCE_VIEW);
    });
    this.registerEditorSuggest(suggest);
    this.registerEditorExtension(editors.extension(projects, suggest));
    this.registerView(BIBLIOGRAPHY_SOURCE_VIEW, (leaf: WorkspaceLeaf): BibliographySourceView => new BibliographySourceView(leaf));
    this.registerEvent(this.app.workspace.on("layout-change", (): void => editors.invalidate()));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor: Editor, info: { file: TAbstractFile | null }): void => {
      if (info.file) projects.invalidate(info.file.path);
    }));

    const manifestChanged = (file: TAbstractFile, oldPath?: string): void => {
      if (file.name.toLowerCase() === CONFIG_PATH || oldPath?.split("/").at(-1)?.toLowerCase() === CONFIG_PATH) {
        projects.refreshRoots();
      }
    };
    this.registerEvent(this.app.vault.on("create", manifestChanged));
    this.registerEvent(this.app.vault.on("delete", manifestChanged));
    this.registerEvent(this.app.vault.on("rename", manifestChanged));
    this.addCommand({
      id: "go-to-bananamark-reference",
      name: "跳转到 BananaMark 引用的定义",
      editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView | MarkdownFileInfo): boolean => {
        if (!(view instanceof MarkdownView)) return false;
        const file = view.file;
        const cm = file ? editors.viewFor(editor, file.path) : undefined;
        if (!file || !cm || cm.compositionStarted || cm.state.selection.ranges.length !== 1) return false;
        const doc = cm.state.doc;
        const offset = editor.posToOffset(editor.getCursor());
        const current = projects.current(cm);
        if (current) {
          if (!current.chapter.references.some((item: Reference): boolean => item.from <= offset && offset <= item.to)) return false;
        } else if (!editor.getLine(editor.getCursor().line).includes("@")) return false;
        if (!checking) {
          void (async (): Promise<void> => {
            const context = await projects.readCurrent(file.path, editor);
            if (view.file !== file || this.app.workspace.activeEditor?.editor !== editor
              || cm.state.doc !== doc || editor.posToOffset(editor.getCursor()) !== offset
              || !editors.viewFor(editor, file.path)) return;
            if (!context) {
              warnNavigationFailure();
              return;
            }
            const reference = context.chapter.references.find((item: Reference): boolean => item.from <= offset && offset <= item.to);
            if (!reference) return;
            const target = findTarget(reference.key, context.analysis);
            if (!target) {
              new Notice(`找不到「${reference.key}」的唯一定义。`);
              return;
            }
            if (!await openSourceTarget(this.app, view.leaf, context.project, target)) warnNavigationFailure();
          })().catch(warnNavigationFailure);
        }
        return true;
      },
    });
  }

  private async moveRules(from: string, to: string): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(PROJECT_PANEL)) {
      if (leaf.view instanceof ProjectPanel) leaf.view.moved(from, to);
    }
    const scope = moveScope(this.writingScope, from, to);
    if (JSON.stringify(scope) !== JSON.stringify(this.writingScope)) await this.updateWritingScope(scope);
  }

  updateWritingScope(scope: WritingScope): Promise<void> {
    scope = {folders: scopeRules(scope.folders), files: scopeRules(scope.files)};
    this.writingScope = scope;
    this.refreshWritingScope();
    // Serialize rename bursts and setting edits. Other plugin settings survive each save.
    const pending = this.settingsWrite.catch((): void => {}).then(async (): Promise<void> => {
      const existing: Record<string, unknown> | null = await this.loadData();
      await this.saveData({ ...existing, writingScope: scope });
      await this.scopeMoves?.refresh();
    });
    this.settingsWrite = pending;
    return pending;
  }

  refreshWritingScope(): void {
    this.writingProjects?.refreshRoots();
    this.writingEditors?.invalidate();
  }
}
