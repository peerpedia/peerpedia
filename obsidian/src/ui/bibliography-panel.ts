import { Notice, type App } from "obsidian";

import { addEntry, patchEntry, readEntries, removeEntry, restoreSourceLineEndings, type BibliographyEntry } from "../bibliography/document";
import type { CitationRename, CitationUse } from "../bibliography/rename";
import type { LanguageWorker } from "../host/language-worker";
import type { VaultProjectStore } from "../host/vault-store";
import { configChange } from "../project/management";
import type { FileChange } from "../project/store";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import { errorMessage } from "./conflict-modal";
import { button, PaperForm } from "./paper-form";

interface BibliographyPanelContext {
  app: App;
  store: VaultProjectStore;
  worker: LanguageWorker;
  project: ProjectSnapshot;
  save: (project: ProjectSnapshot, changes: readonly FileChange[]) => Promise<void>;
}

interface OpenBibliography {
  project: ProjectSnapshot;
  source: SourceFile;
}

function bibliographySource(project: ProjectSnapshot): SourceFile | undefined {
  return project.files.find((item: SourceFile): boolean => item.path === project.config.bibliography);
}

function replaceSource(source: SourceFile, afterText: string): FileChange {
  return { path: source.path, beforeDigest: source.digest, afterText };
}

function bibliographyEntry(source: SourceFile, key: string): BibliographyEntry {
  const entry = readEntries(source.text).find((item: BibliographyEntry): boolean => item.key === key);
  if (!entry) throw new Error(`找不到条目「${key}」。`);
  return entry;
}

function openEditor(context: BibliographyPanelContext, action: (snapshot: OpenBibliography) => void): void {
  void context.store.read(context.project.root).then((project: ProjectSnapshot): void => {
    const source = bibliographySource(project);
    if (!source) throw new Error("找不到共享书目原文件。");
    if (source.path !== context.project.config.bibliography) throw new Error("共享书目路径已更改，请重新打开。");
    action({ project, source });
  }).catch((error: unknown): void => { new Notice(errorMessage(error)); });
}

function attachForm(context: BibliographyPanelContext): void {
  const form = new PaperForm(context.app, "添加共享书目");
  const path = form.field("论文内的 YAML 路径", context.project.config.bibliography ?? "references.yaml");
  path.disabled = Boolean(context.project.config.bibliography);
  form.submit("添加书目", async (): Promise<void> => {
    const bibliography = path.value.trim();
    if (!context.project.config.bibliography && !/\.ya?ml$/i.test(bibliography)) throw new Error("请输入 .yaml 或 .yml 文件路径。");
    const existing = await context.store.member(context.project.root, bibliography);
    const changes: FileChange[] = [{ path: bibliography, beforeDigest: existing?.digest ?? null, afterText: existing?.text ?? "" }];
    if (!context.project.config.bibliography) {
      changes.push(configChange(context.project, { ...context.project.config, bibliography }));
    }
    await context.save(context.project, changes);
  });
  form.open();
}

const types = [
  ["book", "图书"], ["article", "期刊文章"], ["incollection", "文集章节"],
  ["thesis", "学位论文"], ["preprint", "预印本"], ["online", "网页"],
] as const;

function fieldText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function entryForm(context: BibliographyPanelContext, { project, source }: OpenBibliography, existing?: BibliographyEntry): void {
  const form = new PaperForm(context.app, existing ? `编辑 @${existing.key}` : "新增条目");
  const key = existing ? undefined : form.field("引用键");
  const fields = existing?.fields ?? {};
  const initialType = existing ? fieldText(fields.type) : "book";
  const wrapper = form.contentEl.createEl("label");
  wrapper.createSpan({ text: "类型" });
  const type = wrapper.createEl("select");
  if (!types.some(([value]: readonly [string, string]): boolean => value === initialType)) {
    type.createEl("option", { value: initialType, text: initialType || "请选择" });
  }
  for (const [value, label] of types) type.createEl("option", { value, text: label });
  type.value = initialType;
  const title = form.field("标题", fieldText(fields.title), true);
  const author = fields.author === undefined || fields.author === null || typeof fields.author === "string"
    ? form.field("作者", fieldText(fields.author)) : undefined;
  const year = form.field("年份", fieldText(fields.year));
  const initialTitle = title.value;
  const initialAuthor = author?.value;
  const initialYear = year.value;
  form.submit("保存条目", async (): Promise<void> => {
    const patch: Record<string, string> = {};
    if (!existing || type.value !== initialType) {
      if (!type.value) throw new Error("请选择书目类型。");
      patch.type = type.value;
    }
    if (!existing || title.value !== initialTitle) {
      if (!title.value.trim()) throw new Error("请输入标题。");
      patch.title = title.value;
    }
    for (const [name, label, input, initial] of [["author", "作者", author, initialAuthor], ["year", "年份", year, initialYear]] as const) {
      if (!input || input.value === initial) continue;
      const text = input.value.trim();
      if (!text) throw new Error(`请在 YAML 原文件中移除${label}字段。`);
      if (name === "year" && !/^\d{4}$/.test(text)) throw new Error("请输入四位年份。");
      patch[name] = text;
    }
    const name = key?.value.trim() ?? existing!.key;
    if (!existing) {
      await context.worker.run("validateCitationKey", { project, key: name });
    }
    const afterText = existing ? patchEntry(source.text, name, patch) : addEntry(source.text, name, patch);
    await context.save(project, [replaceSource(source, afterText)]);
  });
  form.open();
}

function showImpact(parent: HTMLElement, references: readonly CitationUse[], deleting: boolean): void {
  parent.empty();
  parent.createEl("p", { text: references.length
    ? deleting ? `删除后有 ${references.length} 处引用将失去定义。` : `将更新 ${references.length} 处引用。`
    : "没有找到引用。" });
  if (!references.length) return;
  const list = parent.createEl("ul", { cls: "peerpedia-citation-impact" });
  for (const { path, line, column, key, entry, field, version } of references) {
    const detail = entry === undefined ? "" : ` · ${entry}${version === undefined ? "" : `（版本 ${version}）`} · ${field}`;
    list.createEl("li", { text: `${path} · ${line}:${column}${detail} · @${key}` });
  }
}

function renameForm(context: BibliographyPanelContext, { project }: OpenBibliography, key: string): void {
  const form = new PaperForm(context.app, `重命名 @${key}`);
  const input = form.field("新引用键", key);
  const impact = form.contentEl.createDiv({ attr: { "aria-live": "polite" } });
  input.oninput = (): void => { form.request.cancel(); impact.empty(); };
  button(form.contentEl, "查看引用", (): void => {
    impact.setText("正在查找引用…");
    const unchanged = form.request.begin((): boolean => form.contentEl.isConnected);
    void context.worker.run("citationRename", { project, from: key, to: input.value.trim() })
      .then(({ changes, references }: CitationRename): void => {
        if (!unchanged()) return;
        showImpact(impact, references, false);
        const confirm = button(impact, "确认重命名", (): void => {
          confirm.disabled = true;
          void context.save(project, changes).then((): void => form.close())
            .catch((error: unknown): void => {
              if (!unchanged()) return;
              confirm.disabled = false;
              impact.createEl("p", { text: errorMessage(error), attr: { role: "alert" } });
            });
        });
        confirm.addClass("mod-cta");
      }).catch((error: unknown): void => { if (unchanged()) impact.setText(errorMessage(error)); });
  });
  form.open();
}

function deleteForm(context: BibliographyPanelContext, { project, source }: OpenBibliography, key: string): void {
  const form = new PaperForm(context.app, `删除 @${key}`);
  const impact = form.contentEl.createDiv({ attr: { "aria-live": "polite" }, text: "正在查找引用…" });
  form.open();
  const unchanged = form.request.begin((): boolean => form.contentEl.isConnected);
  void context.worker.run("citationImpact", { project, key }).then((references: readonly CitationUse[]): void => {
    if (!unchanged()) return;
    const afterText = removeEntry(source.text, key);
    showImpact(impact, references, true);
    form.submit("确认删除", (): Promise<void> => context.save(project, [replaceSource(source, afterText)]));
  }).catch((error: unknown): void => { if (unchanged()) impact.setText(errorMessage(error)); });
}

function sourceForm(context: BibliographyPanelContext, { project, source }: OpenBibliography): void {
  const form = new PaperForm(context.app, `编辑 ${source.path}`);
  const text = form.field("YAML 源码", source.text, true);
  text.addClass("peerpedia-bibliography-text", "peerpedia-bibliography-editor");
  text.setAttribute("spellcheck", "false");
  text.setAttribute("wrap", "off");
  form.submit("保存原文件", (): Promise<void> => {
    const afterText = restoreSourceLineEndings(source.text, text.value);
    return context.save(project, [replaceSource(source, afterText)]);
  });
  form.open();
}

export function renderBibliography(parent: HTMLElement, context: BibliographyPanelContext): void {
  const section = parent.createEl("section", { cls: "peerpedia-bibliography-panel" });
  section.createEl("h4", { text: "共享书目" });
  const source = bibliographySource(context.project);
  if (!source) {
    const missing = context.project.config.bibliography;
    if (missing) section.createEl("p", { text: `缺少书目原文件「${missing}」。` });
    button(section, missing ? "创建书目文件" : "添加书目", (): void => attachForm(context));
    return;
  }
  const actions = section.createDiv({ cls: "peerpedia-actions" });
  button(actions, "打开 YAML 原文件", (): void => openEditor(context, (snapshot: OpenBibliography): void => sourceForm(context, snapshot)));
  let entries: readonly BibliographyEntry[];
  try {
    entries = readEntries(source.text);
  } catch (error: unknown) {
    section.createEl("p", { text: errorMessage(error), attr: { role: "alert" } });
    return;
  }
  button(actions, "新增条目", (): void => openEditor(context, (snapshot: OpenBibliography): void => entryForm(context, snapshot)));
  if (!entries.length) section.createEl("p", { text: "暂无条目。" });
  const list = section.createEl("ul", { cls: "peerpedia-bibliography-list" });
  for (const entry of entries) {
    const row = list.createEl("li");
    row.createEl("strong", { text: fieldText(entry.fields.title) || fieldText(entry.fields.translatedtitle) || "未命名条目" });
    row.createDiv({ text: `@${entry.key}`, cls: "setting-item-description" });
    const tools = row.createDiv({ cls: "peerpedia-actions" });
    button(tools, "编辑条目", (): void => openEditor(context, (snapshot: OpenBibliography): void => {
      entryForm(context, snapshot, bibliographyEntry(snapshot.source, entry.key));
    }));
    button(tools, "重命名引用键", (): void => openEditor(context, (snapshot: OpenBibliography): void => {
      renameForm(context, snapshot, entry.key);
    }));
    button(tools, "删除条目", (): void => openEditor(context, (snapshot: OpenBibliography): void => {
      deleteForm(context, snapshot, entry.key);
    }));
  }
}
