import { join } from "node:path";
import { shell } from "electron";
import { FileSystemAdapter, ItemView, MarkdownView, Notice, type Editor, type ViewStateResult, type WorkspaceLeaf } from "obsidian";

import type { RenderPage, RenderSuccess } from "../../renderer/protocol";
import { openBuffers } from "../host/file-events";
import { openSourceTarget, warnNavigationFailure } from "../host/source-navigation";
import { vaultPath, withEditorSources } from "../host/writing-projects";
import { localTheme } from "../preview/article";
import { PreviewController } from "../preview/controller";
import { PreviewReader } from "../preview/reader";
import { previewRenderer } from "../preview/runtime";
import { bindSourceButton, chapterPath, locatePreview, pageForSource, rawCoordinates, targetPath } from "../preview/source-map";
import { CONFIG_PATH, type ProjectStore } from "../project/store";
import type { ProjectSnapshot, SourceFile } from "../project/types";
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
  private coordinates?: {source: SourceFile; raw: (offset: number) => number};
  private closed = false;

  constructor(leaf: WorkspaceLeaf, private readonly store: ProjectStore, private readonly dir: string) {
    super(leaf);
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    this.controller = new PreviewController(previewRenderer(join(adapter.getBasePath(), dir, "renderer")),
      (): void => this.refresh());
  }

  override getViewType(): string { return PREVIEW_VIEW; }
  override getDisplayText(): string { return "论文预览"; }
  override getIcon(): string { return "book-open"; }
  override getState(): Record<string, unknown> { return {root: this.root}; }

  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const root = (state as {root?: unknown} | null)?.root;
    if (typeof root !== "string" || root === this.root || this.closed) return;
    // A preview leaf belongs to one paper. Opening another paper creates a new split.
    if (this.root !== null) return;
    this.root = root;
    try {
      this.stop = this.store.watch(root, (): void => { void this.reload(root); });
      await this.reload(root);
    } catch (error: unknown) { this.controller.unavailable({message: errorMessage(error)}); }
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass("peerpedia-preview");
    const tools = this.contentEl.createDiv({cls: "peerpedia-actions"});
    this.chapters = tools.createEl("select", {attr: {"aria-label": "预览章节"}});
    this.chapters.onchange = (): void => {
      const page = this.shown?.pages[this.chapters.selectedIndex];
      if (page) this.show(page);
    };
    this.sourceButton = tools.createEl("button", {text: "定位源码"});
    this.sourceButton.disabled = true;
    bindSourceButton(this.sourceButton, (): void => { void this.goToSource().catch(warnNavigationFailure); });
    this.status = this.contentEl.createDiv({attr: {role: "status"}});
    this.position = this.contentEl.createDiv({cls: "peerpedia-preview-position"});
    try {
      const base = this.dir + "/renderer/theme/";
      const adapter = this.app.vault.adapter;
      const theme = localTheme(JSON.parse(await adapter.read(base + "assets.json")),
        (path: string): string => adapter.getResourcePath(base + path));
      const css = await adapter.read(base + "style.css");
      if (this.closed) return;
      const frame = this.contentEl.createEl("iframe", {attr: {title: "论文正文"}});
      this.reader = new PreviewReader(frame, theme, css, (value: string): void => this.openLink(value), (): void => {
        this.reader = undefined;
        this.sourceButton.disabled = true;
        this.status.textContent = "无法加载本地预览样式或字体。";
      });
      this.refresh();
    } catch {
      this.status.textContent = "缺少本地预览组件。请检查插件的 renderer 目录。";
    }
  }

  override async onClose(): Promise<void> {
    this.closed = true;
    this.stop?.();
    ++this.readId;
    await this.controller.dispose();
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
      if (source instanceof MarkdownView && source.file?.path === path) return source.editor.getValue();
      return openBuffers(this.app, path)[0];
    });
    this.controller.update(this.project);
  }

  editorMoved(leaf: WorkspaceLeaf, editor: Editor, file: string, changed: boolean, active: boolean): void {
    if (this.closed || !(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== file) return;
    if (!this.disk) { if (active) this.pendingSource = leaf.view; return; }
    const member = this.disk.files.find((source: SourceFile): boolean => vaultPath(this.disk!.root, source.path) === file);
    if (!member || member.path === CONFIG_PATH) return;
    if (active) {
      this.sourceLeaf = leaf;
      const cursor = editor.getCursor();
      this.cursor = {path: member.path, offset: editor.posToOffset(cursor)};
    }
    if (changed) this.updateBuffers();
    if (active) this.follow();
  }

  private refresh(): void {
    if (!this.reader) return;
    const state = this.controller.state();
    const stale = state.result && state.currentRevision !== state.renderedRevision;
    const error = state.error;
    const where = error && [this.errorFile(error.file), error.line, error.column].filter(Boolean).join(":");
    const problem = error && [where, error.message].filter(Boolean).join(" · ");
    const status = problem ? `预览失败 · ${problem}` : state.busy ? "正在生成预览…" : state.result ? "预览已更新" : "等待论文…";
    this.status.textContent = status + (stale ? " · 显示上次成功预览" : error && !state.result ? " · 暂无预览" : "");
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

  private follow(): void {
    const { project, shown, cursor } = this;
    if (!project || !shown || !cursor || shown.revision !== project.revision || !this.reader) return;
    const page = pageForSource(cursor.path, shown, project);
    if (!page) return;
    const source = project.files.find((file: SourceFile): boolean => file.path === cursor.path);
    if (!source) return;
    if (this.coordinates?.source !== source) this.coordinates = {source, raw: rawCoordinates(source.text)};
    const offset = this.coordinates.raw(cursor.offset);
    const target = locatePreview(cursor.path, offset, shown, project);
    const exact = target && target.from <= offset && offset <= target.to;
    const key = JSON.stringify([page.id, target?.id, offset]);
    if (this.followed === key) return;
    this.followed = key;
    this.show(page);
    if (target && this.reader.scroll(target.id)) this.position.textContent = exact ? "" : "近似定位 · 最近的结构";
    else { this.reader.scroll(null); this.position.textContent = "近似定位 · 章首"; }
  }

  private openLink(link: string): void {
    if (link.startsWith("#") || link.startsWith("?")) {
      const url = new URL(link, "https://preview.invalid/");
      const id = url.searchParams.get("chapter") ?? this.page?.id;
      const page = this.shown?.pages.find((item: RenderPage): boolean => item.id === id);
      if (!page) return;
      this.show(page);
      try { this.reader?.scroll(decodeURIComponent(url.hash.slice(1)) || null); } catch { /* Invalid fragment. */ }
    } else void shell.openExternal(link).catch((): void => { new Notice("无法打开外链。"); });
  }

  private async goToSource(): Promise<void> {
    const { project, shown, page } = this;
    if (!project || !page || project.revision !== shown?.revision || this.sourceButton.disabled) return;
    const target = this.reader?.visibleTarget();
    const path = target ? targetPath(target, project) : chapterPath(page.id, project);
    if (!path) return;
    if (!target) this.position.textContent = "近似定位 · 章首";
    const leaf = this.sourceLeaf && this.app.workspace.getLeavesOfType("markdown").includes(this.sourceLeaf)
      ? this.sourceLeaf : this.app.workspace.getLeaf("tab");
    if (!await openSourceTarget(this.app, leaf, project, { path, from: target?.from ?? 0, to: target?.to ?? 0 })) warnNavigationFailure();
  }
}
