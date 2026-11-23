import { FileSystemAdapter, MarkdownView, Notice, Plugin, type Editor, type MarkdownFileInfo, type TAbstractFile, type WorkspaceLeaf } from "obsidian";

import { WritingEditors } from "./host/editor-extension";
import { BIBLIOGRAPHY_SOURCE_VIEW, BibliographySourceView, openSourceTarget, warnNavigationFailure } from "./host/source-navigation";
import { BananaMarkSuggest } from "./host/suggest";
import { WritingProjects } from "./host/writing-projects";
import { findTarget, referenceAt } from "./language/navigation";
import { resolveScope } from "./project/scope";
import { CONFIG_PATH } from "./project/store";

export interface WritingScope {
  folders: Readonly<Record<string, boolean>>;
  files: Readonly<Record<string, boolean>>;
}

function scopeRules(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry: [string, unknown]): entry is [string, boolean] => typeof entry[1] === "boolean",
  ));
}

export default class PeerpediaPlugin extends Plugin {
  writingScope: WritingScope = { folders: {}, files: {} };
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
    const editors = new WritingEditors((path: string): boolean =>
      resolveScope(path, this.writingScope.folders, this.writingScope.files));
    const projects = new WritingProjects(this.app, adapter.getBasePath(), (): void => editors.invalidate());
    const suggest = new BananaMarkSuggest(
      this.app,
      (editor: Editor, path: string): ReturnType<WritingEditors["viewFor"]> => editors.viewFor(editor, path),
      (path: string, source: string): ReturnType<WritingProjects["completionIndex"]> => projects.completionIndex(path, source),
    );
    this.writingEditors = editors;
    this.writingProjects = projects;
    this.register((): void => {
      suggest.close();
      projects.dispose();
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
        const source = editor.getValue();
        const offset = editor.posToOffset(editor.getCursor());
        const reference = referenceAt(source, offset);
        if (!reference) return false;
        if (!checking) {
          void (async (): Promise<void> => {
            const context = await projects.readCurrent(file.path, editor);
            if (view.file !== file || this.app.workspace.activeEditor?.editor !== editor
              || editor.getValue() !== source || editor.posToOffset(editor.getCursor()) !== offset
              || !editors.viewFor(editor, file.path)) return;
            const target = context && findTarget(reference.key, context.analysis);
            if (!target || !context) {
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

  refreshWritingScope(): void {
    this.writingProjects?.refreshRoots();
    this.writingEditors?.invalidate();
  }
}
