import { Modal, Notice, type App } from "obsidian";
import { restoreSourceLineEndings } from "../bibliography/document";
import { toPublicationDocument, type PublicationDocument } from "../project/publication";
import type { ProjectSnapshot } from "../project/types";
import type { ProjectStore } from "../project/store";
import type { PeerpediaApi } from "../remote/api";
import { applyMerge, planMergedFiles, prepareMerge, resolveMerge, type MergeConflict } from "../remote/merge";
import type { Comparison, MergeAxis } from "../remote/merge-compare";
import type { JsonValue, RemoteCheck } from "../remote/types";
import { errorMessage } from "./conflict-modal";
import { styleModal } from "./controls";
import { button } from "./paper-form";

const labels: Record<string,string> = {title:"Title",authors:"Authors",abstract:"Abstract",primary_category:"Primary subject",secondary_categories:"Secondary subjects",
  license:"License",markdown:"Manuscript",bibliography:"Bibliography",chapters:"Chapters",id:"Chapter ID"};
function conflictLabel(target: string): string {
  const [field, position] = target.split(" · ", 2);
  const translated = ({
    "章节顺序": "Chapter order", "正文": "Manuscript", "单文件与分章正文": "Single-file and chaptered manuscripts",
    "正文与章节": "Manuscript and chapters", "书目 YAML": "Bibliography YAML", "书目开头": "Start of bibliography",
  } as Record<string, string>)[field] ?? labels[field] ?? field
    .replace(/^章节 /u, "Chapter ").replace(/^章名 /u, "Chapter title ").replace(/^书目条目 /u, "Bibliography entry ");
  if (target.startsWith("书目条目 ")) return "Bibliography entry " + target.slice("书目条目 ".length);
  if (position === undefined) return translated;
  return translated + " · Line " + position.replace(/^第 (\d+) 行$/u, "$1");
}
function show(parent: HTMLElement, value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.every((item: JsonValue): boolean => typeof item === "string")) parent.createEl("pre",{text:value.join("\n") || "(empty)"});
    else for (const item of value) show(parent.createDiv(),item);
  } else if (value && typeof value === "object") {
    for (const [key,item] of Object.entries(value)) {
      parent.createEl("strong",{text:labels[key] ?? key});
      show(parent,item);
    }
  } else parent.createEl("pre",{text:value === null ? "(none)" : String(value) || "(empty)"});
}
function section(parent: HTMLElement, title: string): HTMLElement {
  const details = parent.createEl("details");
  details.createEl("summary",{text:title});
  return details.createDiv();
}
function displayDoc(parent: HTMLElement, doc: PublicationDocument): void {
  const {chapters,markdown,...metadata} = doc;
  show(parent,{...metadata,...(chapters.length ? {chapters:[...chapters]} : {markdown})});
}
type ReadEdit = () => JsonValue;
function editor(parent: HTMLElement, label: string, original: JsonValue): ReadEdit {
  if (Array.isArray(original) && original.every((item: JsonValue): item is string => typeof item === "string")) {
    const read = editor(parent,label + " (one per line)",original.join("\n"));
    return (): JsonValue => String(read()).split(/\r?\n/).filter(Boolean);
  }
  if (Array.isArray(original)) {
    const readers = original.map((item: JsonValue,i: number): ReadEdit => editor(parent.createDiv(),label+" "+(i+1),item));
    return (): JsonValue => readers.map((read: ReadEdit): JsonValue => read());
  }
  if (original && typeof original === "object") {
    const reads = Object.entries(original).map(([key,value]: [string,JsonValue]): [string,ReadEdit] =>
      [key,editor(parent.createDiv(),labels[key] ?? key,value)]);
    return (): JsonValue => Object.fromEntries(reads.map(([key,read]: [string,ReadEdit]): [string,JsonValue] => [key,read()]));
  }
  const field = parent.createEl("label");
  field.createSpan({text:label});
  const input = field.createEl("textarea");
  input.value = original === null ? "" : String(original);
  return (): JsonValue => restoreSourceLineEndings(typeof original === "string" ? original : "",input.value);
}

export class MergeView extends Modal {
  private generation = 0;
  constructor(app: App, private readonly project: ProjectSnapshot, private readonly axis: MergeAxis, private readonly store: ProjectStore,
    private readonly api: PeerpediaApi, private readonly update: (observation?: RemoteCheck) => Promise<void>) {
    super(app);
    this.setTitle(axis === "accepted" ? "Compare accepted version" : "Compare open proposal");
    styleModal(this,true);
  }
  override onClose(): void { ++this.generation; }
  override onOpen(): void {
    const id = ++this.generation;
    this.contentEl.setText("Loading the remote version…");
    void prepareMerge(this.project,this.axis,this.store,this.api).then((comparison: Comparison): void => {
      if (id === this.generation) this.renderComparison(comparison,id);
    }).catch((error: unknown): void => { if (id === this.generation) this.contentEl.setText(errorMessage(error)); });
  }

  private renderComparison(comparison: Comparison, id: number): void {
    const box = this.contentEl;
    box.empty();
    const {base,target,result} = comparison;
    box.createEl("p",{text:(this.axis === "accepted" ? "Accepted version " : "Open proposal snapshot ") + (target.publicId ?? target.hash)});
    if (base) displayDoc(section(box,"Common version " + (base.publicId ?? base.hash)),base.document);
    else box.createEl("p",{text:"No common version was found. Compare the local and remote sources and choose a result for each conflict."});
    displayDoc(section(box,"Local manuscript"),toPublicationDocument(this.project));
    displayDoc(section(box,"Remote manuscript"),target.document);
    const choices: Record<string,JsonValue> = Object.create(null);
    const resultBox = section(box,"Merge preview");
    const controls = box.createDiv();
    const status = box.createEl("p",{attr:{role:"status"}});
    const actions = box.createDiv({cls:"peerpedia-actions peerpedia-form-footer"});
    button(actions,"Cancel",(): void => this.close());
    const confirm = button(actions,"Confirm merge",(): void => {
      confirm.disabled = true;
      controls.inert = true;
      let saving = false;
      const save = async (): Promise<void> => {
        const changes = planMergedFiles(this.project,resolveMerge(result,choices));
        status.setText("Checking the remote and local versions again…");
        await applyMerge(this.project,changes,comparison.check,this.store,this.api,(): boolean => {
          if (id !== this.generation) return false;
          saving = true;
          status.setText("Saving the paper and its binding…");
          actions.querySelectorAll("button").forEach((item: HTMLButtonElement): void => { item.disabled = true; });
          return true;
        });
        await this.update(comparison.check);
        if (id === this.generation) this.close();
      };
      void save().catch(async (error: unknown): Promise<void> => {
        if (saving) await this.update().catch((): void => {});
        const message = errorMessage(error) + " Close this window and compare again, or check recovery records in the paper panel.";
        if (id === this.generation) status.setText(message);
        else if (saving) new Notice(message);
      });
    });
    confirm.addClass("mod-cta");
    const refresh = (): void => {
      const pending = result.conflicts.filter((c: MergeConflict): boolean => !Object.hasOwn(choices,c.id));
      confirm.disabled = true;
      resultBox.empty();
      try {
        const preview = {...choices};
        for (const c of pending) preview[c.id] = c.local;
        const document = resolveMerge(result,preview);
        displayDoc(resultBox,document);
        if (!pending.length) { planMergedFiles(this.project,document); confirm.disabled = false; }
        status.setText(pending.length ? "Unresolved conflicts: " + pending.length + ". The preview uses local content for those conflicts." : "Ready to confirm the merge.");
      } catch (error: unknown) { status.setText(errorMessage(error)); }
    };
    for (const c of result.conflicts) {
      const row = controls.createDiv({cls:"peerpedia-merge-conflict"});
      row.createEl("h4",{text:conflictLabel(c.target)});
      if (base) show(section(row,"Original content"),c.base);
      show(section(row,"Local content"),c.local);
      show(section(row,"Remote content"),c.remote);
      const selected = row.createEl("p"), editBox = row.createDiv();
      const choose = (value: JsonValue,label: string): void => {
        choices[c.id] = value;
        selected.setText("Selected: " + label);
        editBox.empty();
        refresh();
      };
      button(row,"Use local",(): void => choose(c.local,"Local"));
      button(row,"Use remote",(): void => choose(c.remote,"Remote"));
      button(row,"Edit result",(): void => {
        const initial = Object.hasOwn(choices,c.id) ? choices[c.id] : c.local ?? c.remote;
        delete choices[c.id];
        selected.setText("Editing");
        editBox.empty();
        const read = editor(editBox,"Result",initial);
        button(editBox,"Use edited result",(): void => choose(read(),"Edit result"));
        refresh();
      });
    }
    refresh();
  }
}
