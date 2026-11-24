import type { Range, Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import type { ChapterLanguage } from "../language/analysis";
import type { Range as SourceRange } from "../language/index";
import type { WritingContext } from "./writing-projects";

function visible(view: EditorView, range: SourceRange): boolean {
  return view.visibleRanges.some(({ from, to }: SourceRange): boolean => range.to >= from && range.from <= to);
}

function chapterMarks(view: EditorView, chapter: ChapterLanguage): Range<Decoration>[] {
  const marks: Range<Decoration>[] = [];
  for (const { from, to, kind, classes } of chapter.marks) {
    if (visible(view, { from, to })) marks.push(Decoration.mark({ class: classes ? `peerpedia-source-token ${classes}` : `peerpedia-source-${kind}` }).range(from, to));
  }
  return marks;
}

function diagnosticMarks(view: EditorView, chapter: ChapterLanguage): Range<Decoration>[] {
  const marks: Range<Decoration>[] = [];
  for (const issue of chapter.diagnostics) {
    if (!visible(view, issue)) continue;
    const from = Math.min(issue.from, view.state.doc.length);
    const to = Math.min(issue.to, view.state.doc.length);
    if (from < to) {
      marks.push(Decoration.mark({
        class: "peerpedia-source-error",
        attributes: { title: issue.message },
      }).range(from, to));
    } else {
      marks.push(Decoration.line({
        class: "peerpedia-source-error-line",
        attributes: { title: issue.message },
      }).range(view.state.doc.lineAt(from).from));
    }
  }
  return marks;
}

export function sourceDecorations(
  lookup: (view: EditorView) => { path: string; context: WritingContext | null } | null,
): Extension {
  return ViewPlugin.fromClass(class {
    private syntax: DecorationSet = Decoration.none;
    private context: WritingContext | null = null;
    private path: string | undefined;
    private diagnostics: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
      this.refresh(view, true);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.syntax = this.syntax.map(update.changes);
      this.refresh(update.view, update.viewportChanged);
    }

    ranges(): readonly DecorationSet[] {
      return [this.syntax, this.diagnostics];
    }

    private refresh(view: EditorView, viewportChanged: boolean): void {
      const current = lookup(view);
      const path = current?.path;
      const context = current?.context ?? null;
      if (path !== this.path) {
        this.syntax = Decoration.none;
        this.path = path;
      }
      if (context === this.context && !viewportChanged) return;
      this.context = context;
      if (context) {
        this.syntax = Decoration.set(chapterMarks(view, context.chapter), true);
        this.diagnostics = Decoration.set(diagnosticMarks(view, context.chapter), true);
      } else this.diagnostics = Decoration.none;
    }
  }, {
    provide(plugin: ViewPlugin<{ ranges(): readonly DecorationSet[] }>): Extension {
      return [0, 1].map((index: number): Extension => EditorView.decorations.of(
        (view: EditorView): DecorationSet => view.plugin(plugin)?.ranges()[index] ?? Decoration.none,
      ));
    },
  });
}
