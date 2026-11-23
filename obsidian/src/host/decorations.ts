import type { Range, Extension, Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { scanChapter, type SyntaxMark } from "../language/index";
import { editorOffset } from "../language/navigation";
import type { WritingContext } from "./writing-projects";

function syntaxRanges(marks: readonly SyntaxMark[]): Range<Decoration>[] {
  return marks.map(({ from, to, kind }: SyntaxMark): Range<Decoration> => Decoration.mark({
    class: `peerpedia-source-${kind}`,
  }).range(from, to));
}

function diagnosticRanges(context: WritingContext, doc: Text): Range<Decoration>[] {
  const ranges: Range<Decoration>[] = [];
  for (const issue of context.analysis.diagnostics) {
    if (issue.path !== context.path) continue;
    const from = Math.min(editorOffset(context.source, issue.from), doc.length);
    const to = Math.min(editorOffset(context.source, issue.to), doc.length);
    if (from < to) {
      ranges.push(Decoration.mark({
        class: "peerpedia-source-error",
        attributes: { title: issue.message },
      }).range(from, to));
    } else {
      ranges.push(Decoration.line({
        class: "peerpedia-source-error-line",
        attributes: { title: issue.message },
      }).range(doc.lineAt(from).from));
    }
  }
  return ranges;
}

export function sourceDecorations(
  lookup: (view: EditorView, source: string) => WritingContext | null,
): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none;
    private source: string | undefined;
    private syntax: readonly Range<Decoration>[] = [];
    private context: WritingContext | null = null;

    constructor(view: EditorView) {
      this.refresh(view);
    }

    update(update: ViewUpdate): void {
      this.refresh(update.view);
    }

    private refresh(view: EditorView): void {
      const source = view.state.doc.toString();
      const context = lookup(view, source);
      if (source === this.source && context === this.context) return;
      if (source !== this.source) {
        this.source = source;
        this.syntax = syntaxRanges(scanChapter(source, "").marks);
      }
      this.context = context;
      const issues = context && !view.compositionStarted ? diagnosticRanges(context, view.state.doc) : [];
      this.decorations = Decoration.set([...this.syntax, ...issues], true);
    }
  }, { decorations: (instance: { decorations: DecorationSet }): DecorationSet => instance.decorations });
}
