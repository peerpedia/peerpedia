import { UserFacingError } from "../user-error";
import { Notice, type App } from "obsidian";

import { readEntries, restoreSourceLineEndings, type BibliographyEntry } from "../bibliography/document";
import type { CitationRename, CitationUse } from "../bibliography/rename";
import type { LanguageWorker } from "../host/language-worker";
import type { VaultProjectStore } from "../host/vault-store";
import { configChange } from "../project/management";
import type { FileChange } from "../project/store";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import { errorMessage } from "./conflict-modal";
import { iconButton } from "./controls";
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

function openEditor(context: BibliographyPanelContext, action: (snapshot: OpenBibliography) => void): void {
  void context.store.read(context.project.root).then((project: ProjectSnapshot): void => {
    const source = bibliographySource(project);
    if (!source) throw new UserFacingError("The shared bibliography file is missing.");
    if (source.path !== context.project.config.bibliography) throw new UserFacingError("The shared bibliography path changed. Reopen the paper.");
    action({ project, source });
  }).catch((error: unknown): void => { new Notice(errorMessage(error)); });
}

function attachForm(context: BibliographyPanelContext): void {
  const form = new PaperForm(context.app, "Add shared bibliography");
  const path = form.field("YAML path within the paper folder", context.project.config.bibliography ?? "references.yaml");
  path.disabled = Boolean(context.project.config.bibliography);
  form.submit("Add bibliography", async (): Promise<void> => {
    const bibliography = path.value.trim();
    if (!context.project.config.bibliography && !/\.ya?ml$/i.test(bibliography)) throw new UserFacingError("Enter a .yaml or .yml file path.");
    const existing = await context.store.member(context.project.root, bibliography);
    const changes: FileChange[] = [{ path: bibliography, beforeDigest: existing?.digest ?? null, afterText: existing?.text ?? "" }];
    if (!context.project.config.bibliography) {
      changes.push(configChange(context.project, { ...context.project.config, bibliography }));
    }
    await context.save(context.project, changes);
  });
  form.open();
}

function fieldText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function showImpact(parent: HTMLElement, references: readonly CitationUse[]): void {
  parent.empty();
  parent.createEl("p", { text: references.length
    ? `Citations to update: ${references.length}.`
    : "No citations found." });
  if (!references.length) return;
  const list = parent.createEl("ul", { cls: "peerpedia-citation-impact" });
  for (const { path, line, column, key, entry, field, version } of references) {
    const detail = entry === undefined ? "" : ` · ${entry}${version === undefined ? "" : ` (version ${version})`} · ${field}`;
    list.createEl("li", { text: `${path} · ${line}:${column}${detail} · @${key}` });
  }
}

function renameForm(context: BibliographyPanelContext, { project }: OpenBibliography, key: string): void {
  const form = new PaperForm(context.app, `Rename @${key}`);
  const input = form.field("New citation key", key);
  const impact = form.contentEl.createDiv({ attr: { "aria-live": "polite" } });
  input.oninput = (): void => { form.request.cancel(); impact.empty(); };
  button(form.contentEl, "Find citations", (): void => {
    impact.setText("Finding citations…");
    const unchanged = form.request.begin((): boolean => form.contentEl.isConnected);
    void context.worker.run("citationRename", { project, from: key, to: input.value.trim() })
      .then(({ changes, references }: CitationRename): void => {
        if (!unchanged()) return;
        showImpact(impact, references);
        const confirm = button(impact, "Confirm rename", (): void => {
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

function sourceForm(context: BibliographyPanelContext, { project, source }: OpenBibliography): void {
  const form = new PaperForm(context.app, `Edit ${source.path}`);
  const text = form.field("YAML source", source.text, true);
  text.addClass("peerpedia-bibliography-text", "peerpedia-bibliography-editor");
  text.setAttribute("spellcheck", "false");
  text.setAttribute("wrap", "off");
  form.submit("Save source file", async (): Promise<void> => {
    const afterText = restoreSourceLineEndings(source.text, text.value);
    readEntries(afterText);
    return context.save(project, [replaceSource(source, afterText)]);
  });
  form.open();
}

export function renderBibliography(parent: HTMLElement, context: BibliographyPanelContext): void {
  const section = parent.createEl("section", { cls: "peerpedia-bibliography-panel" });
  section.createEl("p", { text: "Add, edit or remove references in the YAML source. Use Rename citation key to update citations across the paper.", cls:"peerpedia-description" });
  const source = bibliographySource(context.project);
  if (!source) {
    const missing = context.project.config.bibliography;
    if (missing) section.createEl("p", { text: `The bibliography file "${missing}" is missing.` });
    button(section, missing ? "Create bibliography file" : "Add bibliography", (): void => attachForm(context));
    return;
  }
  const actions = section.createDiv({ cls: "peerpedia-actions" });
  button(actions, "Edit YAML source", (): void => openEditor(context, (snapshot: OpenBibliography): void => sourceForm(context, snapshot)));
  let entries: readonly BibliographyEntry[];
  try {
    entries = readEntries(source.text);
  } catch (error: unknown) {
    section.createEl("p", { text: errorMessage(error), attr: { role: "alert" } });
    return;
  }
  if (!entries.length) section.createEl("p", { text: "No entries yet." });
  const search=section.createEl("input",{type:"search",cls:"peerpedia-search",attr:{placeholder:"Search title, author or citation key","aria-label":"Search references"}});
  const list=section.createEl("ul",{cls:"peerpedia-bibliography-list"});
  for(const entry of entries){
    const row=list.createEl("li");
    const link=row.createDiv({cls:"peerpedia-reference"});
    link.createEl("strong",{text:fieldText(entry.fields.title)||fieldText(entry.fields.translatedtitle)||"Untitled entry"});
    link.createEl("small",{text:[fieldText(entry.fields.author),fieldText(entry.fields.year)].filter(Boolean).join(" · ")});
    link.createEl("code",{text:"@"+entry.key});
    iconButton(row, "Rename citation key: " + entry.key, "text-cursor-input", (): void =>
      openEditor(context, (snapshot: OpenBibliography): void => renameForm(context, snapshot, entry.key)));
  }
  search.oninput=(): void => {
    const query=search.value.toLocaleLowerCase();
    list.querySelectorAll<HTMLLIElement>("li").forEach((row: HTMLLIElement): void => {row.hidden=!row.textContent?.toLocaleLowerCase().includes(query);});
  };
}
