import type { EditorView } from "@codemirror/view";
import {
  EditorSuggest, Notice, type App, type Editor, type EditorPosition, type EditorSuggestContext,
  type EditorSuggestTriggerInfo, type TFile,
} from "obsidian";

import { completionTrigger, suggestionsFor, type Suggestion } from "../language/completion";
import type { ProjectAnalysis } from "../language/analysis";

interface Choice {
  suggestion: Suggestion;
  view: EditorView;
  source: string;
  offset: number;
  path: string;
  revision: string | null;
}

interface NativeEditorSuggest {
  trigger(editor: Editor, file: TFile, allowOpen: boolean): boolean;
}

export class BananaMarkSuggest extends EditorSuggest<Choice> {
  private explicit = false;
  private warnedAboutManualTrigger = false;

  constructor(
    app: App,
    private readonly viewFor: (editor: Editor, path: string) => EditorView | undefined,
    private readonly indexFor: (path: string, source: string) => ProjectAnalysis & { path: string },
  ) {
    super(app);
    this.limit = 30;
  }

  override onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    const view = file ? this.viewFor(editor, file.path) : undefined;
    if (!view || view.compositionStarted || view.state.readOnly
      || view.state.selection.ranges.length !== 1 || !view.state.selection.main.empty) return null;
    const query = editor.getLine(cursor.line).slice(0, cursor.ch);
    if (!completionTrigger(query, this.explicit)) return null;
    const token = /\S*$/.exec(query)?.[0] ?? "";
    return { start: { line: cursor.line, ch: cursor.ch - token.length }, end: cursor, query };
  }

  override getSuggestions(context: EditorSuggestContext): Choice[] {
    const path = context.file.path;
    const view = this.viewFor(context.editor, path);
    if (!view || view.compositionStarted) return [];
    const offset = context.editor.posToOffset(context.end);
    const line = view.state.doc.lineAt(offset);
    const source = view.state.doc.toString();
    const reference = completionTrigger(line.text.slice(0, offset - line.from), this.explicit) === "reference";
    const analysis = reference ? this.indexFor(path, source) : { revision: "", labels: [], diagnostics: [], path };
    return suggestionsFor({ path: analysis.path, source, offset, explicit: this.explicit, composing: false }, analysis)
      .map((suggestion: Suggestion): Choice => ({
        suggestion, view, source, offset, path, revision: reference ? analysis.revision : null,
      }));
  }

  override renderSuggestion(choice: Choice, element: HTMLElement): void {
    element.setText(choice.suggestion.label);
  }

  override selectSuggestion(choice: Choice): void {
    const editor = this.context?.editor;
    const { view, source, offset, path, suggestion, revision } = choice;
    this.close();
    if (!editor || this.viewFor(editor, path) !== view || view.compositionStarted
      || view.state.readOnly || view.state.selection.ranges.length !== 1
      || !view.state.selection.main.empty || view.state.selection.main.head !== offset
      || source !== view.state.doc.toString()) return;
    if (revision !== null && this.indexFor(path, source).revision !== revision) return;
    view.dispatch({
      changes: { from: suggestion.from, to: suggestion.to, insert: suggestion.insertText },
      selection: { anchor: suggestion.from + suggestion.cursorOffset },
      userEvent: "input.complete",
      scrollIntoView: true,
    });
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
          new Notice("当前 Obsidian 版本不支持手动触发 BananaMark 补全。");
        }
        return false;
      }
      this.close();
      return native.trigger(editor, file, true);
    } finally {
      this.explicit = false;
    }
  }
}
