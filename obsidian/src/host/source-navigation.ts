import {
  ItemView, MarkdownView, Notice, type App, type Editor, type TFile, type WorkspaceLeaf,
} from "obsidian";

import type { LabelTarget, Range } from "../language/index";
import { editorOffset } from "../language/navigation";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import { editorText, vaultPath } from "./writing-projects";

export const BIBLIOGRAPHY_SOURCE_VIEW = "peerpedia-bibliography-source";

export class BibliographySourceView extends ItemView {
  override getViewType(): string {
    return BIBLIOGRAPHY_SOURCE_VIEW;
  }

  override getDisplayText(): string {
    return "书目源码";
  }

  show(path: string, source: string, target: Range): void {
    this.contentEl.empty();
    this.contentEl.addClass("peerpedia-bibliography-view");
    this.contentEl.createEl("h2", { text: path });
    const text = this.contentEl.createEl("textarea", {
      cls: "peerpedia-bibliography-text",
      attr: { readonly: "", "aria-label": `书目源码 ${path}`, wrap: "off" },
    });
    text.value = editorText(source);
    const from = editorOffset(source, target.from);
    const to = editorOffset(source, target.to);
    text.focus();
    text.setSelectionRange(from, to);
    const line = text.value.slice(0, from).split("\n").length - 1;
    const style = text.ownerDocument.defaultView?.getComputedStyle(text);
    text.scrollTop = Math.max(0, line * (Number.parseFloat(style?.lineHeight ?? "") || 20) - text.clientHeight / 2);
  }
}

/** Open a target from the supplied snapshot only if the source still agrees. */
export async function openSourceTarget(
  app: App, leaf: WorkspaceLeaf, project: ProjectSnapshot, target: Pick<LabelTarget, "path" | "from" | "to">,
): Promise<boolean> {
  const source = project.files.find((file: SourceFile): boolean => file.path === target.path)?.text;
  if (source === undefined || !Number.isInteger(target.from) || !Number.isInteger(target.to)
    || target.from < 0 || target.to < target.from || target.to > source.length) return false;
  const path = vaultPath(project.root, target.path);
  if (target.path === project.config.bibliography) {
    if (await app.vault.adapter.read(path) !== source) return false;
    const existing = app.workspace.getLeavesOfType(BIBLIOGRAPHY_SOURCE_VIEW)[0];
    const destination = existing ?? app.workspace.getLeaf("tab");
    if (!existing) await destination.setViewState({ type: BIBLIOGRAPHY_SOURCE_VIEW, active: true });
    if (!(destination.view instanceof BibliographySourceView)) return false;
    await app.workspace.revealLeaf(destination);
    app.workspace.setActiveLeaf(destination, { focus: true });
    destination.view.show(path, source, target);
    return true;
  }
  const file: TFile | null = app.vault.getFileByPath(path);
  if (!file) return false;
  await leaf.openFile(file, { active: true, state: { mode: "source", source: true } });
  if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== path) return false;
  const editor: Editor = leaf.view.editor;
  if (editor.getValue() !== editorText(source)) return false;
  const from = editor.offsetToPos(editorOffset(source, target.from));
  const to = editor.offsetToPos(editorOffset(source, target.to));
  editor.setSelection(from, to);
  editor.scrollIntoView({ from, to }, true);
  editor.focus();
  return true;
}

export function warnNavigationFailure(): void {
  new Notice("源码已更改或无法打开。请再次跳转。");
}
