import type { LanguageWorker } from "../host/language-worker";
import { join } from "node:path";
import { shell } from "electron";
import { FileSystemAdapter, ItemView, MarkdownView, Notice, type Editor, type ViewStateResult, type WorkspaceLeaf } from "obsidian";

import type { RenderPage, RenderSuccess } from "../../renderer/protocol";
import { openBuffers } from "../host/file-events";
import { openSourceTarget, warnNavigationFailure } from "../host/source-navigation";
import { withEditorSources } from "../host/writing-projects";
import { PreviewController } from "../preview/controller";
import { PreviewReader, readTheme } from "../preview/reader";
import type { PublicationDocument } from "../project/publication";
import type { RenderService } from "../preview/browser-renderer-client";
import { bindSourceButton, chapterPath, locatePreview, pageForSource, previewMember, rawCoordinates, targetPath } from "../preview/source-map";
import { pathKey } from "../project/path-identity";
import { CONFIG_PATH, type ProjectStore } from "../project/store";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import { iconButton } from "./controls";
import { errorMessage } from "./conflict-modal";

export const PREVIEW_VIEW = "peerpedia-paper-preview";

interface SourcePosition { path: string; offset: number }

export class PreviewView extends ItemView {
  private root: string | null = null;
  private disk?: ProjectSnapshot;
  private project?: ProjectSnapshot;
  private stop?: () => void;
  private readId = 0;
  private controller: PreviewController;
  private status!: HTMLElement;
  private position!: HTMLElement;
  private chapters!: HTMLSelectElement;
  private sourceButton!: HTMLButtonElement;
  private reader?: PreviewReader;
  private shown?: RenderSuccess;
  private page?: RenderPage;
  private cursor?: SourcePosition;
  private sourceLeaf?: WorkspaceLeaf;
  private pendingSource?: MarkdownView;
  private followed?: string;
  private sourceHint?: {revision: string; path: string; from: number; to: number; text: string};
  private coordinates?: {source: SourceFile; raw: (offset: number) => number};
  private closed = false;

  constructor(leaf: WorkspaceLeaf, private readonly store: ProjectStore, language: LanguageWorker, renderer: RenderService) {
    super(leaf);
    this.controller = new PreviewController({
      convert: (project: ProjectSnapshot, signal: AbortSignal): Promise<PublicationDocument> => language.run("publication", project, signal),
      render: renderer.render.bind(renderer),
    }, (): void => this.refresh());
  }

  override getViewType(): string { return PREVIEW_VIEW; }
  override getDisplayText(): string { return "Paper preview"; }
  override getIcon(): string { return "book-open"; }
  override getState(): Record<string, unknown> { return {root: this.root}; }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const root = (state as {root?: unknown} | null)?.root;
    if (typeof root === "string") await this.selectRoot(root);
  }

  async selectRoot(root: string): Promise<void> {
    if (root === this.root || this.closed) return;
    this.stop?.();
    ++this.readId;
    this.root = root;
    this.disk = this.project = undefined;
    this.shown = this.page = this.cursor = this.sourceHint = this.coordinates = undefined;
    this.followed = undefined;
    this.sourceLeaf = this.pendingSource = undefined;
    this.reader?.clear();
    this.chapters?.replaceChildren();
    this.controller.reset();
    try {
      this.stop = this.store.watch(root, (): void => { void this.reload(root); });
      await this.reload(root);
    } catch (error: unknown) { this.controller.unavailable({message: errorMessage(error)}); }
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("peerpedia-preview");
    const tools = this.contentEl.createDiv({cls: "peerpedia-preview-toolbar"});
    this.chapters = tools.createEl("select", {attr: {"aria-label": "Preview chapter"}});
    this.chapters.onchange = (): void => {
      const page = this.shown?.pages[this.chapters.selectedIndex];
      if (page) this.show(page);
    };
    this.sourceButton = iconButton(tools, "Go to source", "file-pen-line", (): void => {});
    this.sourceButton.disabled = true;
    bindSourceButton(this.sourceButton, (): void => { void this.goToSource().catch(warnNavigationFailure); });
    const state = this.contentEl.createDiv({cls: "peerpedia-preview-state"});
    this.status = state.createDiv({attr: {role: "status"}});
    this.position = state.createDiv({cls: "peerpedia-preview-position"});
    try {
      const {theme, css} = readTheme();
      if (this.closed) return;
      const frame = this.contentEl.createEl("iframe", {attr: {title: "Paper manuscript"}});
      this.reader = new PreviewReader(frame, theme, css, (value: string): void => this.openLink(value), (): void => {
        this.reader = undefined;
        this.sourceButton.disabled = true;
        this.status.textContent = "Unable to load local preview styles or fonts.";
      });
      this.refresh();
    } catch {
      this.status.textContent = "The preview runtime is missing. Check the plugin’s renderer folder.";
    }
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    this.stop?.();
    ++this.readId;
    this.controller.dispose();
  }

  private async reload(root: string): Promise<void> {
    const id = ++this.readId;
    try {
      const disk = await this.store.read(root);
      if (id !== this.readId) return;
      this.disk = disk;
      const source = this.pendingSource ?? (!this.cursor ? this.app.workspace.getActiveViewOfType(MarkdownView) : null);
      this.pendingSource = undefined;
      if (source?.file) this.editorMoved(source.leaf, source.editor, source.file.path, false, true);
      this.updateBuffers();
    } catch (error: unknown) {
      if (id !== this.readId) return;
      this.disk = undefined;
      this.project = undefined;
      this.controller.unavailable({message: errorMessage(error)});
    }
  }

  private updateBuffers(): void {
    if (!this.disk) return;
    this.project = withEditorSources(this.disk, (path: string): string | undefined => {
      const source = this.sourceLeaf?.view;
      if (source instanceof MarkdownView && source.file && pathKey(source.file.path) === pathKey(path)) return source.editor.getValue();
      return openBuffers(this.app, path)[0];
    });
    this.controller.update(this.project);
  }

  editorMoved(leaf: WorkspaceLeaf, editor: Editor, file: string, changed: boolean, active: boolean, activated: boolean = false): void {
    if (this.closed || !(leaf.view instanceof MarkdownView) || !leaf.view.file || pathKey(leaf.view.file.path) !== pathKey(file)) return;
    if (!this.disk) { if (active) this.pendingSource = leaf.view; return; }
    const member = previewMember(this.disk, file);
    if (!member || member.path === CONFIG_PATH) return;
    if (active) {
      this.sourceLeaf = leaf;
      const cursor = editor.getCursor();
      this.cursor = {path: member.path, offset: editor.posToOffset(cursor)};
    }
    if (changed) this.updateBuffers();
    if (active) this.follow(activated);
  }

  private refresh(): void {
    if (!this.reader) return;
    const state = this.controller.state();
    const stale = state.result && state.currentRevision !== state.renderedRevision;
    const error = state.error;
    const where = error && [this.errorFile(error.file), error.line, error.column].filter(Boolean).join(":");
    const problem = error && [where, error.message].filter(Boolean).join(" · ");
    const status = problem ? `Preview failed · ${problem}` : state.busy ? "Rendering preview…" : state.result ? "Preview updated" : "Waiting for a paper…";
    this.status.textContent = status + (stale ? " · Showing the last successful preview" : error && !state.result ? " · No preview available" : "");
    this.sourceButton.disabled = !state.result || Boolean(stale);
    if (state.result && state.result !== this.shown) {
      this.shown = state.result;
      this.chapters.replaceChildren();
      for (const page of state.result.pages) this.chapters.createEl("option", {value: page.id, text: page.title || page.id});
      const selected = state.result.pages.find((page: RenderPage): boolean => page.id === this.page?.id) ?? state.result.pages[0];
      if (selected) this.show(selected);
      this.followed = undefined;
    }
    if (!stale) this.follow();
    else this.position.textContent = "";
  }

  private errorFile(file?: string): string | undefined {
    if (file === "references.yaml") return this.project?.config.bibliography ?? file;
    return file?.endsWith(".md") && this.project ? chapterPath(file.slice(0, -3), this.project) ?? file : file;
  }

  private show(page: RenderPage): void {
    this.page = page;
    this.chapters.value = page.id;
    this.reader?.show(page);
    this.position.textContent = "";
  }

  private follow(activated: boolean = false): void {
    const { project, shown, cursor } = this;
    if (!project || !shown || !cursor || shown.revision !== project.revision || !this.reader) return;
    const page = pageForSource(cursor.path, shown, project);
    if (!page) return;
    const source = project.files.find((file: SourceFile): boolean => file.path === cursor.path);
    if (!source) return;
    if (this.coordinates?.source !== source) this.coordinates = {source, raw: rawCoordinates(source.text)};
    const offset = this.coordinates.raw(cursor.offset);
    const target = locatePreview(cursor.path, offset, shown, project);
    const hint = this.sourceHint;
    if (hint && (hint.revision !== shown.revision || hint.path !== cursor.path || offset < hint.from || offset > hint.to)) {
      this.sourceHint = undefined;
    }
    const exact = target && target.from <= offset && offset <= target.to && !this.sourceHint;
    const key = JSON.stringify([page.id, target?.id, offset]);
    if (!activated && this.followed === key) return;
    this.followed = key;
    this.show(page);
    if (target && this.reader.scroll(target.id, Boolean(exact))) this.position.textContent = this.sourceHint?.text ?? (exact ? "" : "Approximate position · Nearest element");
    else { this.reader.scroll(null); this.position.textContent = "Approximate position · Start of chapter"; }
  }

  private openLink(link: string): void {
    if (link.startsWith("#") || link.startsWith("?")) {
      const url = new URL(link, "https://preview.invalid/");
      const id = url.searchParams.get("chapter") ?? this.page?.id;
      const page = this.shown?.pages.find((item: RenderPage): boolean => item.id === id);
      if (!page) return;
      this.show(page);
      let fragment: string | null = null;
      try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { /* Malformed link. */ }
      if (fragment !== null && this.reader?.scroll(fragment || null)) return;
      const nearest = this.reader?.visibleTarget().target;
      this.reader?.scroll(nearest?.id ?? null, false);
      this.position.textContent = nearest ? "Approximate position · Nearest element" : "Approximate position · Start of chapter";
    } else void shell.openExternal(link).catch((): void => { new Notice("Unable to open the external link."); });
  }

  private async goToSource(): Promise<void> {
    const { project, shown, page } = this;
    if (!project || !page || project.revision !== shown?.revision || this.sourceButton.disabled) return;
    this.sourceHint = undefined;
    const location = this.reader?.visibleTarget();
    const target = location?.target;
    const path = target ? targetPath(target, project) : chapterPath(page.id, project);
    if (!path) return;
    const leaf = this.sourceLeaf && this.app.workspace.getLeavesOfType("markdown").includes(this.sourceLeaf)
      ? this.sourceLeaf : this.app.workspace.getLeaf("tab");
    if (!await openSourceTarget(this.app, leaf, project, { path, from: target?.from ?? 0, to: target?.to ?? 0 })) {
      warnNavigationFailure();
    } else if (!location?.exact && this.shown === shown && !this.closed) {
      // Host focus/selection events may follow this programmatic selection later.
      const text = target ? "Approximate position · Nearest element" : "Approximate position · Start of chapter";
      this.sourceHint = {revision: shown.revision, path, from: target?.from ?? 0, to: target?.to ?? 0, text};
      this.position.textContent = text;
    }
  }
}
