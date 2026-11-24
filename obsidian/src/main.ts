import { LanguageWorker } from "./host/language-worker";
import { UserFacingError } from "./user-error";
import { join } from "node:path";
import type { Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, FileSystemAdapter, TFile, MarkdownView, Notice, Plugin, type Editor, type MarkdownFileInfo, type TAbstractFile, type WorkspaceLeaf, type View } from "obsidian";

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
import { isManuscriptPath } from "./project/path-identity";
import { WorkspaceContext } from "./ui/workspace-context";
import { projectMembers, CONFIG_PATH } from "./project/store";

import { SubmissionController } from "./remote/controller";
import { BrowserRendererClient } from "./preview/browser-renderer-client";
import type { RenderRequest, RenderResponse } from "../renderer/protocol";
import { DEFAULT_ORIGIN, storedIdentity } from "./remote/account";
import { HostCredentials, type CredentialReferences } from "./remote/host-credentials";
import { NodeTransport } from "./remote/transport";
import type { AccountIdentity } from "./remote/types";
import { ConnectionModal } from "./ui/connection-modal";

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
  private connectionIdentity: AccountIdentity|null = null;
  private importOrigin = DEFAULT_ORIGIN;
  private writingEditors: WritingEditors | undefined;
  private writingProjects: WritingProjects | undefined;

  override async onload(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const settings: { writingScope?: Partial<WritingScope>; connection?: unknown; connectionCleanup?: unknown; credentialReferences?: unknown } | null = await this.loadData();
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
    const transport = new NodeTransport();
    this.connectionIdentity = storedIdentity(settings?.connection);
    this.importOrigin = this.connectionIdentity?.origin ?? DEFAULT_ORIGIN;
    const language = new LanguageWorker();
    this.register((): void => language.dispose());
    const credentials = new HostCredentials(this.app.secretStorage, settings?.credentialReferences,
      (references: CredentialReferences): Promise<void> => this.mutateSettings((data: Record<string, unknown>): void => {
        data.credentialReferences = references;
      }));
    const renderer = new BrowserRendererClient();
    this.register(():void => { void renderer.dispose(); });
    const submissions = new SubmissionController(store,():AccountIdentity|null => this.connectionIdentity,credentials,transport,
      (request:RenderRequest,signal:AbortSignal):Promise<RenderResponse> => renderer.render(request,signal));
    this.addSettingTab(new ScopeSettings(this.app, this));
    this.registerView(PROJECT_PANEL, (leaf: WorkspaceLeaf): ProjectPanel => new ProjectPanel(leaf, store,
      (root: string): Promise<void> => this.updateWritingScope({
        ...this.writingScope, folders: { ...this.writingScope.folders, [root]: true },
      }), (): string => this.importOrigin, transport, language, submissions, {
        preview:(root: string): Promise<void> => openPaperPreview(root), connect:(): void => connection.open(),
      }));
    const paperRoot = async (file: TAbstractFile | null): Promise<string | undefined> => {
      if (!file || !isManuscriptPath(file.path)) return undefined;
      for (let parent = file.parent; parent; parent = parent.parent) {
        const folder = parent.isRoot() ? "" : parent.path;
        if (await adapter.exists(folder ? folder + "/" + CONFIG_PATH : CONFIG_PATH)) {
          const project = await store.read(folder);
          const member = folder ? file.path.slice(folder.length+1) : file.path;
          return projectMembers(project.config).includes(member) ? folder : undefined;
        }
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
      if (!(leaf.view instanceof ProjectPanel)) throw new UserFacingError("Unable to open the paper management panel.");
      return leaf.view;
    };
    const cleanup = Array.isArray(settings?.connectionCleanup) ? settings.connectionCleanup.map(storedIdentity)
      .filter((item: AccountIdentity | null): item is AccountIdentity => item !== null) : [];
    const connection = new ConnectionModal(this.app, storedIdentity(settings?.connection), transport,
      credentials,
      (identity: AccountIdentity | null, pending: readonly AccountIdentity[]): Promise<void> => this.updateConnection(identity, pending), cleanup);
    this.addCommand({ id: "connect-account", name: "Connect or disconnect a Peerpedia account", callback: (): void => connection.open() });
    this.register((): void => connection.close());
    this.registerView(PREVIEW_VIEW, (leaf: WorkspaceLeaf): PreviewView => new PreviewView(leaf, store, language, renderer));
    const openPaperPreview = async (selectedRoot?: string): Promise<void> => {
      const root = selectedRoot ?? await paperRoot(this.app.workspace.getActiveFile());
      if(root===undefined){new Notice("Open a chapter in a paper folder first.");return;}
      const project=await store.read(root);
      const members=new Set(projectMembers(project.config).filter((path: string): boolean => /\.md$/i.test(path))
        .map((path: string): string => root ? root+"/"+path : path));
      const active=this.app.workspace.getActiveViewOfType(MarkdownView);
      let source=active?.file&&members.has(active.file.path) ? active : this.app.workspace.getLeavesOfType("markdown")
        .map((item: WorkspaceLeaf): View => item.view).find((view: View): view is MarkdownView => view instanceof MarkdownView&&Boolean(view.file&&members.has(view.file.path)));
      if(!source){
        const path=[...members][0], file=path&&this.app.vault.getAbstractFileByPath(path);
        if(!(file instanceof TFile))throw new UserFacingError("The manuscript source is missing.");
        const sourceLeaf=this.app.workspace.getLeaf("tab");
        await sourceLeaf.openFile(file,{active:true});
        if(!(sourceLeaf.view instanceof MarkdownView))return;
        source=sourceLeaf.view;
      }
      const file=source.file;
      if(!file||!members.has(file.path))return;
      let leaf=this.app.workspace.getLeavesOfType(PREVIEW_VIEW)[0];
      if(!leaf){
        leaf=this.app.workspace.createLeafBySplit(source.leaf,"vertical");
        await leaf.setViewState({type:PREVIEW_VIEW,state:{root},active:false});
      }else if(leaf.view instanceof PreviewView)await leaf.view.selectRoot(root);
      await this.app.workspace.revealLeaf(leaf);
      if(leaf.view instanceof PreviewView)leaf.view.editorMoved(source.leaf,source.editor,file.path,true,true,true);
      this.app.workspace.setActiveLeaf(source.leaf,{focus:true});
    };
    this.addCommand({id:"preview-paper",name:"Open paper preview",callback:(): void => {
      void openPaperPreview().catch((error: unknown): void => {new Notice(errorMessage(error));});
    }});
    const notifyPreviews = (info: MarkdownView, changed: boolean, activated: boolean): void => {
      const path = info.file?.path;
      if (!path) return;
      for (const leaf of this.app.workspace.getLeavesOfType(PREVIEW_VIEW)) {
        if (leaf.view instanceof PreviewView) leaf.view.editorMoved(info.leaf, info.editor, path, changed,
          this.app.workspace.activeLeaf === info.leaf, activated);
      }
    };
    const context = new WorkspaceContext((path: string): Promise<string | undefined> => paperRoot(this.app.vault.getAbstractFileByPath(path)),
      async (root: string, path: string): Promise<void> => {
        const changes: Promise<void>[] = [];
        for (const leaf of this.app.workspace.getLeavesOfType(PROJECT_PANEL)) {
          if (leaf.view instanceof ProjectPanel) changes.push(leaf.view.followFile(root,path));
        }
        for (const leaf of this.app.workspace.getLeavesOfType(PREVIEW_VIEW)) {
          if (leaf.view instanceof PreviewView) changes.push(leaf.view.selectRoot(root));
        }
        await Promise.all(changes);
        const active = this.app.workspace.getActiveViewOfType(MarkdownView);
        if(active?.file?.path===path)notifyPreviews(active,true,true);
      });
    this.register((): void => context.cancel());
    const follow = (file: TAbstractFile | null): void => {
      if(file)void context.follow(file.path).catch((error: unknown): void => {new Notice(errorMessage(error));});
      else context.cancel();
    };
    this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf: WorkspaceLeaf | null): void => {
      if (leaf?.view instanceof MarkdownView) {notifyPreviews(leaf.view,true,true);follow(leaf.view.file);}
    }));
    this.registerEvent(this.app.workspace.on("file-open",follow));
    this.app.workspace.onLayoutReady((): void => follow(this.app.workspace.getActiveFile()));
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
    this.addCommand({ id: "manage-paper", name: "Manage paper", callback: (): void => showPanel(false) });
    this.addCommand({ id: "create-paper", name: "Create paper", callback: (): void => showPanel(true) });
    this.addCommand({ id:"import-paper", name:"Import paper from Peerpedia", callback:(): void => {
      void openPanel().then((panel: ProjectPanel): void => panel.importForm())
        .catch((error: unknown): void => { new Notice(errorMessage(error)); });
    } });
    this.addRibbonIcon("book-open", "Manage paper", (): void => showPanel(false));
    this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, from: string): void => {
      if (isStagedMove(file.path)) return;
      void this.moveRules(from, file.path).catch((error: unknown): void => { new Notice(errorMessage(error)); });
    }));
    const editors = new WritingEditors((path: string): boolean =>
      resolveScope(path, this.writingScope.folders, this.writingScope.files));
    const projects = new WritingProjects(this.app, adapter.getBasePath(), (): void => editors.invalidate(), language);
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
        message.createSpan({text: `"${member}" changed outside Obsidian. Your draft was saved. `});
        message.createEl("button", {text: "Review versions"}).onclick = (): void => {
          void openPanel(root).then((panel: ProjectPanel): Promise<void> => panel.revealRecovery(root, record))
            .catch((error: unknown): void => { new Notice(errorMessage(error)); });
        };
        new Notice(message, 15000);
      }).catch((error: unknown): void => { new Notice(`Unable to save the draft. ${errorMessage(error)}`); });
    }));
    const suggest = new BananaMarkSuggest(
      this.app,
      (editor: Editor, path: string): ReturnType<WritingEditors["viewFor"]> => editors.viewFor(editor, path),
      projects, language,
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
      name: "Go to BananaMark reference definition",
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
              new Notice(`No unique definition found for "${reference.key}".`);
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
    return this.mutateSettings((settings: Record<string,unknown>): void => { settings.writingScope = scope; })
      .then(async (): Promise<void> => { await this.scopeMoves?.refresh(); });
  }

  updateConnection(identity: AccountIdentity | null, cleanup: readonly AccountIdentity[] = []): Promise<void> {
    return this.mutateSettings((settings: Record<string,unknown>): void => {
      if (identity) settings.connection = {origin:identity.origin, username:identity.username};
      else delete settings.connection;
      if (cleanup.length) {
        settings.connectionCleanup = cleanup.map((item: AccountIdentity): AccountIdentity => ({origin:item.origin, username:item.username}));
      } else delete settings.connectionCleanup;
    }).then((): void => { this.connectionIdentity = identity; this.importOrigin = identity?.origin ?? DEFAULT_ORIGIN; });
  }

  private mutateSettings(change: (settings: Record<string,unknown>) => void): Promise<void> {
    const pending = this.settingsWrite.catch((): void => {}).then(async (): Promise<void> => {
      const existing: Record<string, unknown> | null = await this.loadData();
      const settings = { ...existing };
      change(settings);
      await this.saveData(settings);
    });
    this.settingsWrite = pending;
    return pending;
  }

  refreshWritingScope(): void {
    this.writingProjects?.refreshRoots();
    this.writingEditors?.invalidate();
  }
}
