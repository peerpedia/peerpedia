import { randomUUID } from "node:crypto";
import { ItemView, Modal, Notice, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { TitlePreview } from "../language/title-preview";
import { renderBibliography } from "./bibliography-panel";
import { button, PaperForm } from "./paper-form";
import { LanguageWorker } from "../host/language-worker";
import { openBuffers } from "../host/file-events";
import { VaultProjectStore } from "../host/vault-store";
import { chapterTitleEdit, changeMembership, configChange, newPaper, reorderChapter } from "../project/management";
import { RECOVERY_DIR, type RecoveryNotice } from "../project/recovery";
import { CONFIG_PATH, type FileChange, type ProjectEvent } from "../project/store";
import type { ChapterSpec, ProjectSnapshot, SourceFile } from "../project/types";
import { ConflictModal, errorMessage, openLocalFile } from "./conflict-modal";

export const PROJECT_PANEL = "peerpedia-project";

export class ProjectPanel extends ItemView {
  private root: string | null = null;
  private snapshot: ProjectSnapshot | null = null;
  private stop?: () => void;
  private readId = 0;
  private selection = 0;
  private readonly languageWorker = new LanguageWorker();
  private readonly titles = new Map<string, {digest: string; title: Promise<string>}>();
  private records: readonly RecoveryNotice[] = [];

  constructor(leaf: WorkspaceLeaf, readonly store: VaultProjectStore,
    private readonly enableFolder: (root: string) => Promise<void>) { super(leaf); }

  override getViewType(): string { return PROJECT_PANEL; }
  override getDisplayText(): string { return "论文管理"; }
  override getIcon(): string { return "book-open"; }
  override getState(): Record<string, unknown> { return { root: this.root }; }
  override async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const root = (state as { root?: unknown } | null)?.root;
    if (typeof root === "string") await this.selectRoot(root);
  }
  override async onOpen(): Promise<void> { this.render(); }
  override async onClose(): Promise<void> { this.stop?.(); ++this.readId; ++this.selection; this.languageWorker.dispose(); this.titles.clear(); }

  async selectRoot(root: string): Promise<void> {
    this.stop?.();
    ++this.readId;
    const selection = ++this.selection;
    this.titles.clear();
    this.root = root;
    this.snapshot = null;
    this.records = [];
    try {
      const records = await this.store.recovery(root);
      if (selection !== this.selection) return;
      this.records = records;
      this.stop = this.store.watch(root, (_event: ProjectEvent): void => { void this.reload(); });
    } catch (error: unknown) { if (selection === this.selection) this.render(error); return; }
    await this.reload();
  }

  moved(from: string, to: string): void {
    if (this.root === from || this.root?.startsWith(from + "/")) void this.selectRoot(to + this.root.slice(from.length));
  }

  private async reload(): Promise<void> {
    const root = this.root;
    if (root === null) return;
    const id = ++this.readId;
    try {
      const current = await this.store.read(root);
      if (id !== this.readId || this.snapshot?.revision === current.revision) return;
      this.snapshot = current;
      this.render();
    } catch (error: unknown) {
      if (id !== this.readId) return;
      this.snapshot = null;
      this.render(error);
    }
  }

  private async reveal(root: string, record: RecoveryNotice): Promise<void> {
    const form = new Modal(this.app);
    form.setTitle("恢复文件");
    form.contentEl.addClass("peerpedia-paper-form");
    form.contentEl.createEl("p", { text: record.message });
    try {
      const files = await this.store.recoveryFiles(root, record.transactionId);
      for (const file of files) {
        form.contentEl.createEl("h4", { text: file.path });
        for (const version of file.versions) {
          const details = form.contentEl.createEl("details");
          details.createEl("summary", { text: version.label });
          details.createEl("pre", { text: version.text });
        }
      }
    } catch { form.contentEl.createEl("p", { text: "部分内容无法读取，可到文件夹中检查原件。" }); }
    button(form.contentEl, "在访达中显示", (): void => {
      void this.store.localPath(root, RECOVERY_DIR + "/" + record.transactionId)
        .then((path: string): Promise<void> => openLocalFile(path, true))
        .catch((error: unknown): void => { new Notice(errorMessage(error)); });
    });
    form.open();
  }

  private async conflict(root: string, error: unknown): Promise<void> {
    const records = await this.store.recovery(root).catch((): RecoveryNotice[] => []);
    if (this.root === root) { this.records = records; this.snapshot = null; await this.reload(); }
    new ConflictModal(this.app, error, records, (record: RecoveryNotice): Promise<void> => this.reveal(root, record)).open();
  }

  private async save(project: ProjectSnapshot, changes: readonly FileChange[]): Promise<void> {
    try {
      await this.store.apply(project.root, project.revision, changes);
      await this.reload();
    } catch (error: unknown) {
      await this.conflict(project.root, error);
      throw error;
    }
  }

  private render(error?: unknown): void {
    this.contentEl.empty();
    this.contentEl.addClass("peerpedia-project-panel");
    const actions = this.contentEl.createDiv({ cls: "peerpedia-actions" });
    button(actions, "打开论文", (): void => {
      const form = new PaperForm(this.app, "打开论文");
      const folder = form.field("库内文件夹（库根目录留空）", this.root ?? "");
      form.submit("打开", async (): Promise<void> => { await this.selectRoot(folder.value.trim()); });
      form.open();
    });
    button(actions, "新建论文", (): void => this.createForm());
    if (this.root !== null) this.contentEl.createEl("p", { text: this.root || "库根目录", cls: "setting-item-description" });
    if (error && this.root !== null) {
      const root = this.root;
      this.contentEl.createEl("p", { text: errorMessage(error), attr: { role: "alert" } });
      button(this.contentEl, "打开 paper.json 原文件", (): void => {
        void this.store.localPath(root, CONFIG_PATH).then((path: string): Promise<void> => openLocalFile(path, false))
          .catch((err: unknown): void => { new Notice(errorMessage(err)); });
      });
    }
    for (const record of this.records) {
      const root = this.root!;
      const item = this.contentEl.createDiv();
      item.createEl("p", { text: record.message });
      item.createEl("small", { text: record.paths.join("、") });
      button(item, "查看恢复文件", (): void => {
        void this.reveal(root, record).catch((err: unknown): void => { new Notice(errorMessage(err)); });
      });
    }
    const project = this.snapshot;
    if (!project) return;
    this.contentEl.createEl("h3", { text: project.config.title || "未命名论文" });
    button(this.contentEl, "编辑论文信息", (): void => this.metadataForm(project));
    this.contentEl.createEl("h4", { text: "正文" });
    const chapters = project.config.chapters ?? [];
    if (!chapters.length) this.contentEl.createEl("p", { text: "paper.md" });
    const list = this.contentEl.createEl("ol");
    chapters.forEach((chapter: ChapterSpec, index: number): void => {
      const row = list.createEl("li");
      row.draggable = true;
      row.ondragstart = (event: DragEvent): void => {
        event.dataTransfer?.setData("application/x-peerpedia-chapter", JSON.stringify([project.revision, chapter.id]));
      };
      row.ondragover = (event: DragEvent): void => event.preventDefault();
      row.ondrop = (event: DragEvent): void => {
        event.preventDefault();
        const data = event.dataTransfer?.getData("application/x-peerpedia-chapter");
        if (!data) return;
        try {
          const [revision, id]: [string, string] = JSON.parse(data);
          if (revision !== project.revision) throw new Error("拖动期间论文已更改，请重新排序。");
          this.move(project, id, index);
        } catch (err: unknown) { new Notice(errorMessage(err)); }
      };
      const file = project.files.find((f: SourceFile): boolean => f.path === chapter.file);
      const heading = row.createEl("strong", { text: file ? chapter.title || chapter.file : "原文件缺失" });
      if (file) {
        let cached = this.titles.get(file.path);
        if (!cached || cached.digest !== file.digest) {
          cached = { digest: file.digest, title: this.languageWorker.run("title", file.text) };
          this.titles.set(file.path, cached);
        }
        void cached.title.then((title: string): void => {
          if (heading.isConnected && this.snapshot === project) heading.setText(title === "Untitled chapter" ? "未命名章节" : title);
        }).catch((): void => {});
      }
      row.createDiv({ text: chapter.file, cls: "setting-item-description" });
      const tools = row.createDiv({ cls: "peerpedia-actions" });
      button(tools, "上移", (): void => this.move(project, chapter.id, index - 1)).disabled = index === 0;
      button(tools, "下移", (): void => this.move(project, chapter.id, index + 1)).disabled = index === chapters.length - 1;
      button(tools, "改章名", (): void => this.titleForm(project, chapter)).disabled = !file;
      button(tools, "重命名文件", (): void => this.renameForm(project, chapter)).disabled = !file;
      button(tools, "移出论文", (): void => this.removeForm(project, chapter));
    });
    button(this.contentEl, "添加章节", (): void => this.addForm(project));
    renderBibliography(this.contentEl, {
      app: this.app, store: this.store, worker: this.languageWorker, project,
      save: (snapshot: ProjectSnapshot, changes: readonly FileChange[]): Promise<void> => this.save(snapshot, changes),
    });
  }

  private move(project: ProjectSnapshot, id: string, position: number): void {
    void this.save(project, [reorderChapter(project, id, position)]).catch((): void => {});
  }

  createForm(): void {
    const form = new PaperForm(this.app, "新建论文");
    const folder = form.field("新文件夹（相对于库，父文件夹须存在）");
    const title = form.field("论文标题");
    const layout = form.contentEl.createEl("select", { attr: { "aria-label": "正文格式" } });
    layout.createEl("option", { text: "单文件", value: "single" });
    layout.createEl("option", { text: "多章节", value: "chapters" });
    form.submit("创建", async (): Promise<void> => {
      const root = folder.value.trim();
      await this.store.create(root, newPaper(title.value.trim(), layout.value === "chapters"));
      await this.selectRoot(root);
      await this.enableFolder(root).catch((): void => { new Notice("论文已创建，请在设置中启用写作辅助。"); });
    });
    form.open();
  }

  private metadataForm(project: ProjectSnapshot): void {
    const form = new PaperForm(this.app, "编辑论文信息");
    const config = project.config;
    const title = form.field("标题", config.title);
    const authors = form.field("作者", config.authors);
    const abstract = form.field("摘要", config.abstract, true);
    const category = form.field("主分类", config.primary_category);
    const secondary = form.field("其他分类（用逗号分隔）", config.secondary_categories.join(", "));
    const license = form.field("许可", config.license);
    form.submit("保存到 paper.json", (): Promise<void> => this.save(project, [configChange(project, {
      ...config, title: title.value, authors: authors.value, abstract: abstract.value, primary_category: category.value,
      secondary_categories: secondary.value.split(/[,，]/).map((s: string): string => s.trim()).filter(Boolean), license: license.value,
    })]));
    form.open();
  }

  private titleForm(project: ProjectSnapshot, chapter: ChapterSpec): void {
    const form = new PaperForm(this.app, "修改章名");
    const original = project.files.find((file: SourceFile): boolean => file.path === chapter.file)!;
    const title = form.field("章名", chapter.title);
    const preview = form.contentEl.createDiv();
    const current = (): boolean => form.contentEl.isConnected && this.snapshot?.revision === project.revision && this.root === project.root;
    const initial = form.request.begin(current);
    void this.languageWorker.run("title",original.text).then((name: string): void => {
      if (initial()) title.value = name;
    }).catch((): void => {});
    button(form.contentEl, "预览源码修改", (): void => {
      preview.empty();
      const valid = form.request.begin(current);
      void this.languageWorker.run("previewTitle",{source:original.text, title:title.value}).then((result: TitlePreview): void => {
        if (!valid()) return;
        const edits = chapterTitleEdit(project,chapter,result);
        preview.createEl("p", {text:chapter.file});
        preview.createEl("strong", {text:"修改前"}); preview.createEl("pre", {text:result.before || "（文件开头）"});
        preview.createEl("strong", {text:"修改后"}); preview.createEl("pre", {text:result.after});
        const save = button(preview,"确认修改源码",(): void => {
          if (!valid()) { preview.setText("论文已更改，请重新载入。"); return; }
          save.disabled = true;
          void this.save(project,edits).then((): void => form.close()).catch((): void => {save.disabled = false;});
        });
      }).catch((error: unknown): void => { if (valid()) preview.setText(errorMessage(error)); });
    });
    title.oninput = (): void => { form.request.cancel(); preview.empty(); };
    form.open();
  }

  private renameForm(project: ProjectSnapshot, chapter: ChapterSpec): void {
    const form = new PaperForm(this.app, "重命名章节文件");
    if (openBuffers(this.app, project.root ? project.root + "/" + chapter.file : chapter.file).length) {
      form.contentEl.createEl("p", { text: "打开的窗格会转到新路径，之前的撤销记录会清空。" });
    }
    const path = form.field("论文内的新路径", chapter.file);
    form.submit("重命名", async (): Promise<void> => {
      try { await this.store.renameChapter(project, chapter.id, path.value.trim()); }
      catch (error: unknown) { await this.conflict(project.root, error); throw error; }
      await this.reload();
    });
    form.open();
  }

  private addForm(project: ProjectSnapshot): void {
    const form = new PaperForm(this.app, "添加章节");
    const path = form.field("论文内的 Markdown 文件路径");
    form.contentEl.createEl("p", { text: "选择已有文件，或输入新文件名创建空白章节。" });
    path.oninput = (): void => form.request.cancel();
    form.submit("添加", async (): Promise<void> => {
      const current = form.request.begin((): boolean =>
        form.contentEl.isConnected && this.snapshot?.revision === project.revision && this.root === project.root);
      const file = path.value.trim();
      if (!/\.md$/i.test(file)) throw new Error("请输入 .md 文件路径。");
      const existing = await this.store.member(project.root,file);
      const chapters = [...project.config.chapters ?? []];
      if (!chapters.length && file !== "paper.md") {
        const body = project.files.find((f: SourceFile): boolean => f.path === "paper.md");
        chapters.push({file:"paper.md", id:randomUUID(), title:body ? await this.languageWorker.run("title",body.text) : ""});
      }
      if (chapters.some((ch: ChapterSpec): boolean => ch.file === file)) throw new Error("此文件已是论文成员。");
      chapters.push({file,id:randomUUID(),title:await this.languageWorker.run("title",existing?.text ?? "")});
      if (!current()) throw new Error("文件或表单已更改，请重新核对。");
      await this.save(project, [{ path: file, beforeDigest: existing?.digest ?? null, afterText: existing?.text ?? "" },
        changeMembership(project, chapters)]);
    });
    form.open();
  }

  private removeForm(project: ProjectSnapshot, chapter: ChapterSpec): void {
    const form = new PaperForm(this.app, "移出章节");
    const remaining = project.config.chapters!.filter((item: ChapterSpec): boolean => item.id !== chapter.id);
    form.contentEl.createEl("p", { text: `「${chapter.file}」的原文件会保留。` });
    if (!remaining.length) form.contentEl.createEl("p", { text: "移出后，论文将使用单文件正文 paper.md。" });
    form.submit("确认移出", async (): Promise<void> => {
      const changes = [changeMembership(project, remaining)];
      if (!remaining.length && !await this.store.member(project.root, "paper.md")) {
        changes.push({ path: "paper.md", beforeDigest: null, afterText: "" });
      }
      await this.save(project, changes);
    });
    form.open();
  }
}
