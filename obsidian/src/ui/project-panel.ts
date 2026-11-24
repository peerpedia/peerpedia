import { UserFacingError } from "../user-error";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { FuzzySuggestModal, MarkdownView, TFile, ItemView, Modal, Notice, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type { TitlePreview } from "../language/title-preview";
import { renderBibliography } from "./bibliography-panel";
import { actionMenu, iconButton, menuButton, styleModal, type Action } from "./controls";
import { button, PaperForm } from "./paper-form";
import { LanguageWorker } from "../host/language-worker";
import { openBuffers } from "../host/file-events";
import { VaultProjectStore } from "../host/vault-store";
import { chapterTitleEdit, changeMembership, configChange, newPaper, reorderChapter } from "../project/management";
import { RECOVERY_DIR, type RecoveryNotice } from "../project/recovery";
import { CONFIG_PATH, projectMembers, type FileChange, type ProjectEvent } from "../project/store";
import type { ChapterSpec, ProjectSnapshot, SourceFile } from "../project/types";
import { ConflictModal, errorMessage, openLocalFile } from "./conflict-modal";

import type { BindingVersion } from "../remote/binding";
import { checkProject } from "../remote/controller";
import { publication } from "../remote/submit";
import { PeerpediaApi } from "../remote/api";
import type { Category, LicenseOption, RemoteCheck, Transport } from "../remote/types";
import { MergeView } from "./merge-view";
import type { MergeAxis } from "../remote/merge-compare";
import type { SubmissionController } from "../remote/controller";
import { SubmitModal } from "./submit-modal";
import { ImportModal } from "./import-modal";

export const PROJECT_PANEL = "peerpedia-project";

export class ProjectPanel extends ItemView {
  private root: string | null = null;
  private activePath?: string;
  private snapshot: ProjectSnapshot | null = null;
  private stop?: () => void;
  private readId = 0;
  private selection = 0;
  private readonly languageWorker = new LanguageWorker();
  private readonly titles = new Map<string, {digest: string; title: Promise<string>}>();
  private records: readonly RecoveryNotice[] = [];

  private binding?: BindingVersion;
  private bindingError?: string;
  private observation?: RemoteCheck;
  private checking = false;
  private checkError?: string;

  constructor(leaf: WorkspaceLeaf, readonly store: VaultProjectStore,
    private readonly enableFolder: (root: string) => Promise<void>, private readonly origin: () => string,
    private readonly transport: Transport, private readonly dir: string, private readonly submissions?: SubmissionController,
    private readonly workspaceActions?: {preview: (root: string) => Promise<void>; connect: () => void}) { super(leaf); }

  override getViewType(): string { return PROJECT_PANEL; }
  override getDisplayText(): string { return "Manuscript"; }
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
    this.binding = this.observation = this.bindingError = undefined;
    this.checking = false;
    this.checkError = undefined;
    this.render();
    try {
      try {
        const binding = await this.store.readBindingVersion(root);
        if (selection !== this.selection) return;
        this.binding = binding;
      } catch (error: unknown) {
        if (selection !== this.selection) return;
        this.bindingError = errorMessage(error);
      }
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

  async revealRecovery(root: string, record: RecoveryNotice): Promise<void> {
    const form = new Modal(this.app);
    form.setTitle("Recovery files");
    styleModal(form,true);
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
    } catch { form.contentEl.createEl("p", { text: "Some content could not be read. Check the original files in the recovery folder." }); }
    button(form.contentEl, "Reveal in Finder", (): void => {
      void this.store.localPath(root, RECOVERY_DIR + "/" + record.transactionId)
        .then((path: string): Promise<void> => openLocalFile(path, true))
        .catch((error: unknown): void => { new Notice(errorMessage(error)); });
    });
    form.open();
  }

  private async conflict(root: string, error: unknown): Promise<void> {
    const records = await this.store.recovery(root).catch((): RecoveryNotice[] => []);
    if (this.root === root) { this.records = records; this.snapshot = null; await this.reload(); }
    new ConflictModal(this.app, error, records, (record: RecoveryNotice): Promise<void> => this.revealRecovery(root, record)).open();
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

  async followFile(root: string, path: string): Promise<void> {
    this.activePath = path;
    if (this.root !== root) await this.selectRoot(root);
    else this.markActiveChapter();
  }

  private markActiveChapter(): void {
    this.contentEl.querySelectorAll<HTMLElement>("[data-chapter-path]").forEach((row: HTMLElement): void => {
      const active = row.dataset.chapterPath === this.activePath;
      row.toggleClass("is-active", active);
      row.querySelector("button")?.setAttribute("aria-current", active ? "page" : "false");
    });
  }

  private openChapter(project: ProjectSnapshot, path: string): void {
    const full = project.root ? project.root + "/" + path : path;
    const file = this.app.vault.getAbstractFileByPath(full);
    if (!(file instanceof TFile)) { new Notice("The chapter source is missing."); return; }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    const leaf = leaves.find((item: WorkspaceLeaf): boolean => item.view instanceof MarkdownView && item.view.file?.path === full)
      ?? leaves.find((item: WorkspaceLeaf): boolean => item.view instanceof MarkdownView && item.view.file?.path === this.activePath)
      ?? this.app.workspace.getLeaf("tab");
    this.activePath = full;
    this.markActiveChapter();
    void leaf.openFile(file, {active: true}).catch((error: unknown): void => { new Notice(errorMessage(error)); });
  }

  private pickPaper(): void {
    const panel = this;
    new class extends FuzzySuggestModal<string> {
      getItems(): string[] {
        return panel.app.vault.getFiles().filter((file: TFile): boolean => file.name === CONFIG_PATH)
          .map((file: TFile): string => file.parent?.isRoot() ? "" : file.parent?.path ?? "");
      }
      getItemText(root: string): string { return root || "Vault root"; }
      onChooseItem(root: string): void {
        void panel.store.read(root).then((project: ProjectSnapshot): void => {
          // Opening the source drives the same context update as native file navigation.
          panel.openChapter(project, project.config.chapters?.[0]?.file ?? "paper.md");
        }).catch((error: unknown): void => { new Notice(errorMessage(error)); });
      }
    }(this.app).open();
  }

  private render(error?: unknown): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("peerpedia-project-panel");
    const project = this.snapshot;
    const header = el.createDiv({cls: "peerpedia-paper-header"});
    const heading = button(header, project?.config.title || "Peerpedia", (): void => this.pickPaper());
    heading.addClass("peerpedia-paper-switch");
    heading.setAttribute("title", "Switch paper");
    menuButton(header, "Paper actions", (): readonly Action[] => [
      {title:"Switch paper",icon:"folder-open",run:(): void => this.pickPaper()},
      {title:"Create paper",icon:"plus",run:(): void => this.createForm()},
      {title:"Import from Peerpedia",icon:"download",run:(): void => this.importForm()},
      ...(project ? [{title:"Paper details",icon:"settings-2",run:(): void => this.metadataForm(project)}] : []),
      ...(this.workspaceActions ? [{title:"Peerpedia account",icon:"user-round",run:this.workspaceActions.connect}] : []),
    ]);
    const root = this.root;
    if (error && root !== null) {
      const notice = el.createDiv({cls:"peerpedia-attention",text:errorMessage(error),attr:{role:"alert"}});
      button(notice, "Open paper.json", (): void => {
        void this.store.localPath(root, CONFIG_PATH).then((path: string): Promise<void> => openLocalFile(path,false))
          .catch((err: unknown): void => { new Notice(errorMessage(err)); });
      });
    }
    if (this.records.length) {
      const recovery = el.createEl("details",{cls:"peerpedia-attention"});
      recovery.createEl("summary",{text:`File recovery · ${this.records.length} ${this.records.length === 1 ? "record" : "records"}`});
      for (const record of this.records) {
        recovery.createEl("p",{text:record.message});
        button(recovery,"Review saved versions",(): void => {
          void this.revealRecovery(root!,record).catch((err: unknown): void => { new Notice(errorMessage(err)); });
        });
      }
    }
    if (this.bindingError) el.createDiv({cls:"peerpedia-attention",text:this.bindingError,attr:{role:"alert"}});
    if (this.binding?.pendingImport && root !== null) button(el,"Finish interrupted import",(): void => {
      void this.store.recoverImport(root).then(async (): Promise<void> => { if(this.root===root)await this.selectRoot(root); })
        .catch((err: unknown): void => { new Notice(errorMessage(err)); });
    });
    if (this.binding?.pendingMerge && root !== null) button(el,"Recover interrupted merge",(): void => {
      void this.store.recoverMerge(root).then(async (): Promise<void> => { if(this.root===root)await this.selectRoot(root); })
        .catch((err: unknown): void => { new Notice(errorMessage(err)); });
    });
    if (this.binding?.pendingSubmission && root !== null && this.submissions && !this.bindingError && !this.binding.pendingMerge && !this.binding.pendingImport) {
      button(el,"Resume submission",(): void => {
        new SubmitModal(this.app,root,this.store,this.submissions!,this.dir,async (): Promise<void> => {
          if(this.root===root)await this.selectRoot(root);
        }).open();
      }).addClass("mod-cta");
    }
    if (!project) {
      if (!error) el.createEl("p",{cls:"peerpedia-empty",text:root===null ? "Open a manuscript to start writing." : "Opening paper…"});
      if (root===null) {
        button(el,"Open paper",(): void => this.pickPaper()).addClass("mod-cta");
        button(el,"Create paper",(): void => this.createForm());
        button(el,"Import from Peerpedia",(): void => this.importForm());
      }
      return;
    }
    const tools = el.createDiv({cls:"peerpedia-writing-actions"});
    if(this.workspaceActions) button(tools,"Open preview",(): void => {
      void this.workspaceActions!.preview(project.root).catch((err: unknown): void => {new Notice(errorMessage(err));});
    }).addClass("peerpedia-quiet");
    const complete = project.files.length === projectMembers(project.config).length;
    if (this.submissions && !this.bindingError && !this.binding?.pendingMerge && !this.binding?.pendingImport
      && !this.binding?.pendingSubmission && complete) {
      button(tools,this.binding?.pendingSubmission ? "Resume submission" : "Publish",(): void => {
        new SubmitModal(this.app,project.root,this.store,this.submissions!,this.dir,async ():Promise<void> => {
          if(this.root===project.root)await this.selectRoot(project.root);
        }).open();
      }).addClass("mod-cta");
    }
    const section = el.createDiv({cls:"peerpedia-outline-heading"});
    section.createSpan({text:"Manuscript"});
    iconButton(section,"Add chapter","plus",(): void => this.addForm(project));
    const list = el.createEl("ol",{cls:"peerpedia-chapter-list",attr:{"aria-label":"Manuscript chapters"}});
    const chapters = project.config.chapters ?? [];
    const entries: readonly ChapterSpec[] = chapters.length ? chapters : [{id:"main",file:"paper.md",title:"Manuscript"}];
    entries.forEach((chapter: ChapterSpec,index: number): void => {
      const row = list.createEl("li",{cls:"peerpedia-chapter-row"});
      row.dataset.chapterPath = project.root ? project.root + "/" + chapter.file : chapter.file;
      row.draggable = chapters.length > 1;
      row.ondragstart = (event: DragEvent): void => {
        event.dataTransfer?.setData("application/x-peerpedia-chapter",JSON.stringify([project.revision,chapter.id]));
      };
      row.ondragover = (event: DragEvent): void => event.preventDefault();
      row.ondrop = (event: DragEvent): void => {
        event.preventDefault();
        const data = event.dataTransfer?.getData("application/x-peerpedia-chapter");
        if(!data)return;
        try {
          const [revision,id]: [string,string] = JSON.parse(data);
          if(revision!==project.revision)throw new UserFacingError("The paper changed while dragging. Reorder the chapters again.");
          this.move(project,id,index);
        } catch(err: unknown){new Notice(errorMessage(err));}
      };
      const file = project.files.find((item: SourceFile): boolean => item.path===chapter.file);
      const link = button(row,"",(): void => this.openChapter(project,chapter.file));
      link.addClass("peerpedia-chapter-link");
      link.disabled = !file;
      link.setAttribute("title",chapter.file);
      link.createSpan({cls:"peerpedia-chapter-number",text:String(index+1).padStart(2,"0")});
      const label = link.createSpan({cls:"peerpedia-chapter-title",text:file ? chapter.title || chapter.file : "Source file missing"});
      if(file){
        let cached=this.titles.get(file.path);
        if(!cached||cached.digest!==file.digest){cached={digest:file.digest,title:this.languageWorker.run("title",file.text)};this.titles.set(file.path,cached);}
        void cached.title.then((title: string): void => {if(label.isConnected&&this.snapshot===project)label.setText(title);}).catch((): void => {});
      }
      if(chapters.length){
        const actions = (): readonly Action[] => [
          {title:"Rename chapter",icon:"pencil",disabled:!file,run:(): void => this.titleForm(project,chapter)},
          {title:"Move up",icon:"arrow-up",disabled:index===0,run:(): void => this.move(project,chapter.id,index-1)},
          {title:"Move down",icon:"arrow-down",disabled:index===chapters.length-1,run:(): void => this.move(project,chapter.id,index+1)},
          {title:"Rename file",icon:"file-pen-line",disabled:!file,run:(): void => this.renameForm(project,chapter)},
          {title:"Remove from paper",icon:"minus",run:(): void => this.removeForm(project,chapter)},
        ];
        menuButton(row,"Chapter actions: "+(chapter.title||chapter.file),actions);
        row.oncontextmenu=(event: MouseEvent): void => {event.preventDefault();actionMenu(event,actions());};
      }
    });
    this.markActiveChapter();
    const library = el.createDiv({cls:"peerpedia-outline-links"});
    button(library,"References",(): void => {
      const form=new Modal(this.app);form.setTitle("References");styleModal(form,true);
      renderBibliography(form.contentEl,{
        app:this.app,store:this.store,worker:this.languageWorker,project,
        save:async (snapshot: ProjectSnapshot,changes: readonly FileChange[]): Promise<void> => {
          await this.save(snapshot,changes);form.close();
        },
      });
      form.open();
    }).addClass("peerpedia-quiet");
    button(library,"Paper details",(): void => this.metadataForm(project)).addClass("peerpedia-quiet");
    const state = el.createDiv({cls:"peerpedia-paper-status"});
    state.createSpan({cls:"peerpedia-status-dot"});
    const binding = this.binding?.binding;
    state.createSpan({text:!complete ? "Source file missing" : !binding ? "Local paper" :
      isDeepStrictEqual(publication(project),binding.workingBase.document) ? "Matches downloaded version" : "Local changes"});
    if(binding) button(state,"Versions and remote changes",(): void => this.remoteForm(project)).addClass("peerpedia-text-button");
  }

  private remoteForm(project: ProjectSnapshot): void {
    const form = new Modal(this.app);
    form.setTitle("Versions and remote changes");
    styleModal(form);
    const refresh = (): void => {
      if(this.root!==project.root){form.close();return;}
      form.contentEl.empty();
      this.renderRemote(project,form.contentEl,refresh);
    };
    refresh();form.open();
  }

  importForm(): void {
    new ImportModal(this.app,this.origin(),this.transport,this.store,async (project: ProjectSnapshot): Promise<void> => {
      await this.selectRoot(project.root);
      await this.enableFolder(project.root).catch((): void => { new Notice("Enable writing assistance in Settings."); });
    }).open();
  }

  private renderRemote(project: ProjectSnapshot, parent: HTMLElement, refresh: () => void): void {
    const binding = this.binding?.binding, digest = this.binding?.digest;
    if (!binding || !digest) return;
    const box = parent.createDiv();
    box.createEl("p",{text:"Bound site: " + binding.origin});
    const complete = project.files.length === projectMembers(project.config).length;
    const status = !complete ? "Unavailable (source file missing)"
      : isDeepStrictEqual(publication(project),binding.workingBase.document) ? "Match the working version" : "Changed";
    box.createEl("p",{text:"Local files: " + status});
    box.createEl("p",{text:"Last remote check: " + new Date(binding.checkedAt).toLocaleString("en")});
    if (this.observation) {
      box.createEl("p",{text:"Current version at last check: " + (this.observation.current.publicId ?? this.observation.current.hash)});
      box.createEl("p",{text:this.observation.activePr ? "Linked proposal: " + this.observation.activePr.status : "No linked proposal was found during this check."});
    } else box.createEl("p",{text:"Linked proposal status has not been checked since opening."});
    if (this.checkError) box.createEl("p",{text:this.checkError,attr:{role:"alert"}});
    const selection = this.selection;
    if (this.binding?.pendingMerge || this.binding?.pendingSubmission) return;
    const compare = (axis: MergeAxis): void => {
      new MergeView(this.app,project,axis,this.store,new PeerpediaApi(binding.origin,this.transport),async (observation?: RemoteCheck): Promise<void> => {
        if (selection !== this.selection) return;
        await this.selectRoot(project.root);
        if (this.root !== project.root) return;
        this.observation = observation;
        this.render();
      }).open();
    };
    button(box,"Compare accepted version",(): void => compare("accepted"));
    if (binding.activePr || binding.proposalSource || binding.lastSubmitted || binding.workingBase.status !== "accepted" || this.observation?.activePr)
      button(box,"Compare open proposal",(): void => compare("proposal"));
    if (this.observation && this.observation.current.hash !== binding.acceptedBase.hash)
      box.createEl("p",{text:"The site has an accepted version that has not been merged."});
    if (this.observation?.activePr?.status === "pending" && this.observation.activePr.hash !== (binding.activePr ?? binding.workingBase).hash)
      box.createEl("p",{text:"The linked proposal has a snapshot that has not been merged."});
    button(box,"Check remote version", (): void => {
      if (this.checking) return;
      this.checking = true;
      this.checkError = undefined;
      refresh();
      void checkProject(project.root,new PeerpediaApi(binding.origin,this.transport),this.store,digest)
        .then(async (result: RemoteCheck): Promise<void> => {
          const version = await this.store.readBindingVersion(project.root);
          if (selection !== this.selection) return;
          this.binding = version;
          this.observation = result;
        }).catch((err: unknown): void => { if (selection === this.selection) this.checkError = errorMessage(err); })
        .finally((): void => { if (selection === this.selection) { this.checking = false; this.render(); refresh(); } });
    }).disabled = this.checking;
  }

  private move(project: ProjectSnapshot, id: string, position: number): void {
    void this.save(project, [reorderChapter(project, id, position)]).catch((): void => {});
  }

  createForm(): void {
    const form = new PaperForm(this.app, "Create paper");
    const folder = form.field("New folder in the vault (parent folder must exist)");
    const title = form.field("Paper title");
    const layout = form.contentEl.createEl("select", { attr: { "aria-label": "Manuscript layout" } });
    layout.createEl("option", { text: "Single file", value: "single" });
    layout.createEl("option", { text: "Multiple chapters", value: "chapters" });
    form.submit("Create", async (): Promise<void> => {
      const root = folder.value.trim();
      await this.store.create(root, newPaper(title.value.trim(), layout.value === "chapters"));
      await this.selectRoot(root);
      await this.enableFolder(root).catch((): void => { new Notice("Paper created. Enable writing assistance in Settings."); });
    });
    form.open();
  }

  private metadataForm(project: ProjectSnapshot): void {
    const form = new PaperForm(this.app, "Edit paper details");
    const config = project.config;
    const title = form.field("Title", config.title);
    const authors = form.field("Authors", config.authors);
    const abstract = form.field("Abstract", config.abstract, true);
    const category = form.field("Primary subject", config.primary_category);
    const secondary = form.field("Secondary subjects (comma-separated)", config.secondary_categories.join(", "));
    const license = form.field("License", config.license);
    const catalog = this.submissions?.catalog(this.binding?.binding?.origin ?? this.origin());
    if (catalog) {
      const addOptions = (input: HTMLInputElement|HTMLTextAreaElement, options: readonly [string,string][]): void => {
        const list = form.contentEl.createEl("datalist");
        list.id = randomUUID();
        for (const [value,label] of options) list.createEl("option",{value,text:label});
        input.setAttribute("list",list.id);
      };
      addOptions(category,catalog.categories.map((c:Category):[string,string] => [c.id,c.name]));
      addOptions(license,catalog.licenses.map((v:LicenseOption):[string,string] => [v.code,v.label]));
    }
    form.submit("Save to paper.json", (): Promise<void> => this.save(project, [configChange(project, {
      ...config, title: title.value, authors: authors.value, abstract: abstract.value, primary_category: category.value,
      secondary_categories: secondary.value.split(/[,，]/).map((s: string): string => s.trim()).filter(Boolean), license: license.value,
    })]));
    form.open();
  }

  private titleForm(project: ProjectSnapshot, chapter: ChapterSpec): void {
    const form = new PaperForm(this.app, "Rename chapter");
    const original = project.files.find((file: SourceFile): boolean => file.path === chapter.file)!;
    const title = form.field("Chapter title", chapter.title);
    const preview = form.contentEl.createDiv();
    const current = (): boolean => form.contentEl.isConnected && this.snapshot?.revision === project.revision && this.root === project.root;
    const initial = form.request.begin(current);
    void this.languageWorker.run("title",original.text).then((name: string): void => {
      if (initial()) title.value = name;
    }).catch((): void => {});
    button(form.contentEl, "Preview source changes", (): void => {
      preview.empty();
      const valid = form.request.begin(current);
      void this.languageWorker.run("previewTitle",{source:original.text, title:title.value}).then((result: TitlePreview): void => {
        if (!valid()) return;
        const edits = chapterTitleEdit(project,chapter,result);
        preview.createEl("p", {text:chapter.file});
        preview.createEl("strong", {text:"Before"}); preview.createEl("pre", {text:result.before || "(start of file)"});
        preview.createEl("strong", {text:"After"}); preview.createEl("pre", {text:result.after});
        const save = button(preview,"Confirm source changes",(): void => {
          if (!valid()) { preview.setText("The paper changed. Reload it and try again."); return; }
          save.disabled = true;
          void this.save(project,edits).then((): void => form.close()).catch((): void => {save.disabled = false;});
        });
      }).catch((error: unknown): void => { if (valid()) preview.setText(errorMessage(error)); });
    });
    title.oninput = (): void => { form.request.cancel(); preview.empty(); };
    form.open();
  }

  private renameForm(project: ProjectSnapshot, chapter: ChapterSpec): void {
    const form = new PaperForm(this.app, "Rename chapter file");
    if (openBuffers(this.app, project.root ? project.root + "/" + chapter.file : chapter.file).length) {
      form.contentEl.createEl("p", { text: "Open panes will follow the renamed file. Undo history will be cleared." });
    }
    const path = form.field("New path within the paper folder", chapter.file);
    form.submit("Rename", async (): Promise<void> => {
      try { await this.store.renameChapter(project, chapter.id, path.value.trim()); }
      catch (error: unknown) { await this.conflict(project.root, error); throw error; }
      await this.reload();
    });
    form.open();
  }

  private addForm(project: ProjectSnapshot): void {
    const form = new PaperForm(this.app, "Add chapter");
    const path = form.field("Markdown path within the paper folder");
    form.contentEl.createEl("p", { text: "Choose an existing file or enter a new file name to create an empty chapter." });
    path.oninput = (): void => form.request.cancel();
    form.submit("Add", async (): Promise<void> => {
      const current = form.request.begin((): boolean =>
        form.contentEl.isConnected && this.snapshot?.revision === project.revision && this.root === project.root);
      const file = path.value.trim();
      if (!/\.md$/i.test(file)) throw new UserFacingError("Enter a .md file path.");
      const existing = await this.store.member(project.root,file);
      const chapters = [...project.config.chapters ?? []];
      if (!chapters.length && file !== "paper.md") {
        const body = project.files.find((f: SourceFile): boolean => f.path === "paper.md");
        chapters.push({file:"paper.md", id:randomUUID(), title:body ? await this.languageWorker.run("title",body.text) : ""});
      }
      if (chapters.some((ch: ChapterSpec): boolean => ch.file === file)) throw new UserFacingError("This file already belongs to the paper.");
      chapters.push({file,id:randomUUID(),title:await this.languageWorker.run("title",existing?.text ?? "")});
      if (!current()) throw new UserFacingError("The file or form changed. Review it and try again.");
      await this.save(project, [{ path: file, beforeDigest: existing?.digest ?? null, afterText: existing?.text ?? "" },
        changeMembership(project, chapters)]);
    });
    form.open();
  }

  private removeForm(project: ProjectSnapshot, chapter: ChapterSpec): void {
    const form = new PaperForm(this.app, "Remove chapter");
    const remaining = project.config.chapters!.filter((item: ChapterSpec): boolean => item.id !== chapter.id);
    form.contentEl.createEl("p", { text: `The source file "${chapter.file}" will be kept.` });
    if (!remaining.length) form.contentEl.createEl("p", { text: "The paper will use paper.md as its single manuscript file." });
    form.submit("Confirm removal", async (): Promise<void> => {
      const changes = [changeMembership(project, remaining)];
      if (!remaining.length && !await this.store.member(project.root, "paper.md")) {
        changes.push({ path: "paper.md", beforeDigest: null, afterText: "" });
      }
      await this.save(project, changes);
    });
    form.open();
  }
}
