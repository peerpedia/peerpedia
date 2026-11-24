import type { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  EditorSuggest, Notice, type App, type Editor, type EditorPosition, type EditorSuggestContext,
  type EditorSuggestTriggerInfo, type TFile,
} from "obsidian";

import type { Suggestion } from "../language/completion";
import { completionTrigger } from "../language/triggers";
import { LanguageWorker } from "./language-worker";
import type { WritingProjects } from "./writing-projects";

interface Choice {
  suggestion: Suggestion;
  view: EditorView;
  doc: Text;
  offset: number;
  path: string;
  revision: string | null;
}

interface Query {
  context: EditorSuggestContext;
  view: EditorView;
  doc: Text;
  offset: number;
  result: Promise<Choice[]>;
}

interface NativeEditorSuggest {
  trigger(editor: Editor, file: TFile, allowOpen: boolean): boolean;
}

export class BananaMarkSuggest extends EditorSuggest<Choice> {
  private readonly worker = new LanguageWorker();
  private pending: Query | undefined;
  private manual: Pick<Query, "view" | "doc" | "offset"> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private explicit = false;
  private warnedAboutManualTrigger = false;

  constructor(
    app: App,
    private readonly viewFor: (editor: Editor, path: string) => EditorView | undefined,
    private readonly projects: WritingProjects,
  ) {
    super(app);
    this.limit = 30;
  }

  override onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    const view = file ? this.viewFor(editor, file.path) : undefined;
    if (!view || view.compositionStarted || view.state.readOnly
      || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return null;
    const query = editor.getLine(cursor.line).slice(0, cursor.ch);
    if (!completionTrigger(query, this.isExplicit(view, editor.posToOffset(cursor)))) return null;
    const token = /\S*$/.exec(query)?.[0] ?? "";
    return { start: { line: cursor.line, ch: cursor.ch - token.length }, end: cursor, query };
  }

  override getSuggestions(context: EditorSuggestContext): Choice[] | Promise<Choice[]> {
    const { editor, file } = context;
    const path = file.path;
    const view = this.viewFor(editor, path);
    if (!view || view.compositionStarted) return [];
    const offset = editor.posToOffset(context.end);
    const doc = view.state.doc;
    const explicit = this.isExplicit(view, offset);
    const reference = completionTrigger(context.query, explicit) === "reference";
    const query: Query = {
      context, view, doc, offset,
      result: this.queue.then(async (): Promise<Choice[]> => {
        if (!this.isLatest(query)) return [];
        const source = doc.toString();
        const snapshot = reference ? await this.projects.completionSnapshot(path, source) : null;
        if (!this.isLatest(query) || (reference && !snapshot)) return [];
        const revision = snapshot?.project.revision ?? null;
        const items = await this.worker.run("complete", {
          context: { path: snapshot?.path ?? path, source, offset, explicit, composing: false },
          project: snapshot?.project,
        });
        if (!this.isLatest(query) || (revision !== null && !this.projects.isCompletionCurrent(path, source, revision))) return [];
        return items.map((suggestion: Suggestion): Choice => ({ suggestion, view, doc, offset, path, revision }));
      }).catch((): Choice[] => []),
    };
    this.pending = query;
    this.queue = query.result.then((): void => {});
    return this.latestResult(query);
  }

  override renderSuggestion(choice: Choice, element: HTMLElement): void {
    element.setText(choice.suggestion.label);
  }

  override selectSuggestion(choice: Choice): void {
    const editor = this.context?.editor;
    const { view, doc, offset, path, suggestion, revision } = choice;
    this.close();
    if (!editor || this.viewFor(editor, path) !== view || view.compositionStarted
      || view.state.readOnly || view.state.selection.ranges.length !== 1
      || !view.state.selection.main.empty || view.state.selection.main.head !== offset
      || doc !== view.state.doc) return;
    if (revision !== null && !this.projects.isCompletionCurrent(path, doc.toString(), revision)) return;
    view.dispatch({
      changes: { from: suggestion.from, to: suggestion.to, insert: suggestion.insertText },
      selection: { anchor: suggestion.from + suggestion.cursorOffset },
      userEvent: "input.complete",
      scrollIntoView: true,
    });
  }

  override close(): void {
    this.pending = undefined;
    this.manual = undefined;
    super.close();
  }

  openExplicit(editor: Editor, file: TFile): boolean {
    // In Obsidian 1.15.1 trigger is the native editor suggestion manager's
    // entry point. The public API does not yet expose a manual trigger.
    const native = this as unknown as Partial<NativeEditorSuggest>;
    this.explicit = true;
    try {
      if (!this.onTrigger(editor.getCursor(), editor, file)) return false;
      if (typeof native.trigger !== "function") {
        if (!this.warnedAboutManualTrigger) {
          this.warnedAboutManualTrigger = true;
          new Notice("This version of Obsidian does not support triggering BananaMark suggestions manually.");
        }
        return false;
      }
      this.close();
      const view = this.viewFor(editor, file.path);
      if (!view) return false;
      this.manual = { view, doc: view.state.doc, offset: view.state.selection.main.head };
      return native.trigger(editor, file, true);
    } finally {
      this.explicit = false;
    }
  }

  dispose(): void {
    this.close();
    this.worker.dispose();
  }

  private isExplicit(view: EditorView, offset: number): boolean {
    return this.explicit || Boolean(this.manual?.view === view && this.manual.doc === view.state.doc && this.manual.offset === offset);
  }

  private isLatest(query: Query): boolean {
    const { view, context, doc, offset } = query;
    const { selection } = view.state;
    return this.pending === query && this.context?.editor === context.editor && this.context.file === context.file
      && this.context.query === context.query && view.state.doc === doc
      && view.hasFocus && !view.compositionStarted && !view.state.readOnly
      && selection.ranges.length === 1 && selection.main.empty && selection.main.head === offset
      && this.viewFor(context.editor, context.file.path) === view;
  }

  private async latestResult(first: Query): Promise<Choice[]> {
    let query = first;
    let items = await query.result;
    // The native popover closes for an empty response. An overtaken request
    // must yield the latest result rather than close a newer list.
    while (this.pending && this.pending !== query) {
      query = this.pending;
      items = await query.result;
    }
    return this.isLatest(query) ? items : [];
  }
}
