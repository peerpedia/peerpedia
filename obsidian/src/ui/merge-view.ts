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
import { button } from "./paper-form";

const labels: Record<string,string> = {title:"标题",authors:"作者",abstract:"摘要",primary_category:"主分类",secondary_categories:"其他分类",
  license:"许可",markdown:"正文",bibliography:"书目",chapters:"章节",id:"章节 ID"};
function show(parent: HTMLElement, value: JsonValue): void {
  if (Array.isArray(value)) {
    if (value.every((item: JsonValue): boolean => typeof item === "string")) parent.createEl("pre",{text:value.join("\n") || "（空）"});
    else for (const item of value) show(parent.createDiv(),item);
  } else if (value && typeof value === "object") {
    for (const [key,item] of Object.entries(value)) {
      parent.createEl("strong",{text:labels[key] ?? key});
      show(parent,item);
    }
  } else parent.createEl("pre",{text:value === null ? "（无）" : String(value) || "（空）"});
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
    const read = editor(parent,label + "（每行一项）",original.join("\n"));
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
    this.setTitle(axis === "accepted" ? "比较已接受版本" : "比较开放提案");
    this.contentEl.addClass("peerpedia-paper-form");
  }
  override onClose(): void { ++this.generation; }
  override onOpen(): void {
    const id = ++this.generation;
    this.contentEl.setText("正在读取远程版本…");
    void prepareMerge(this.project,this.axis,this.store,this.api).then((comparison: Comparison): void => {
      if (id === this.generation) this.renderComparison(comparison,id);
    }).catch((error: unknown): void => { if (id === this.generation) this.contentEl.setText(errorMessage(error)); });
  }

  private renderComparison(comparison: Comparison, id: number): void {
    const box = this.contentEl;
    box.empty();
    const {base,target,result} = comparison;
    box.createEl("p",{text:(this.axis === "accepted" ? "已接受版本 " : "开放提案快照 ") + (target.publicId ?? target.hash)});
    if (base) displayDoc(section(box,"共同版本 " + (base.publicId ?? base.hash)),base.document);
    else box.createEl("p",{text:"无法确定共同版本。请逐项比较本地与远程来源并选择结果。"});
    displayDoc(section(box,"本地全文"),toPublicationDocument(this.project));
    displayDoc(section(box,"远程全文"),target.document);
    const choices: Record<string,JsonValue> = Object.create(null);
    const resultBox = section(box,"合并结果预览");
    const controls = box.createDiv();
    const status = box.createEl("p",{attr:{role:"status"}});
    const actions = box.createDiv({cls:"peerpedia-actions"});
    button(actions,"取消",(): void => this.close());
    const confirm = button(actions,"确认写入",(): void => {
      confirm.disabled = true;
      controls.inert = true;
      let saving = false;
      const save = async (): Promise<void> => {
        const changes = planMergedFiles(this.project,resolveMerge(result,choices));
        status.setText("正在重新核对远程与本地版本…");
        await applyMerge(this.project,changes,comparison.check,this.store,this.api,(): boolean => {
          if (id !== this.generation) return false;
          saving = true;
          status.setText("正在写入论文与绑定。");
          actions.querySelectorAll("button").forEach((item: HTMLButtonElement): void => { item.disabled = true; });
          return true;
        });
        await this.update(comparison.check);
        if (id === this.generation) this.close();
      };
      void save().catch(async (error: unknown): Promise<void> => {
        if (saving) await this.update().catch((): void => {});
        const message = errorMessage(error) + " 请关闭后重新比较，或在论文管理面板核对恢复记录。";
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
        status.setText(pending.length ? "尚有 " + pending.length + " 处需要选择，预览暂用本地内容。" : "已可确认写入。");
      } catch (error: unknown) { status.setText(errorMessage(error)); }
    };
    for (const c of result.conflicts) {
      const row = controls.createDiv({cls:"peerpedia-merge-conflict"});
      row.createEl("h4",{text:labels[c.target] ?? c.target});
      if (base) show(section(row,"原内容"),c.base);
      show(section(row,"本地内容"),c.local);
      show(section(row,"远程内容"),c.remote);
      const selected = row.createEl("p"), editBox = row.createDiv();
      const choose = (value: JsonValue,label: string): void => {
        choices[c.id] = value;
        selected.setText("已选择：" + label);
        editBox.empty();
        refresh();
      };
      button(row,"采用本地",(): void => choose(c.local,"本地"));
      button(row,"采用远程",(): void => choose(c.remote,"远程"));
      button(row,"编辑结果",(): void => {
        const initial = Object.hasOwn(choices,c.id) ? choices[c.id] : c.local ?? c.remote;
        delete choices[c.id];
        selected.setText("正在编辑");
        editBox.empty();
        const read = editor(editBox,"结果",initial);
        button(editBox,"使用编辑结果",(): void => choose(read(),"编辑结果"));
        refresh();
      });
    }
    refresh();
  }
}
