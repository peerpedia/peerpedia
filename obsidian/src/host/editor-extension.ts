import { Compartment, StateEffect, type Extension } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, type Editor, type TFile } from "obsidian";

import { sourceDecorations } from "./decorations";
import type { BananaMarkSuggest } from "./suggest";
import type { WritingProjects } from "./writing-projects";

export class WritingEditors {
  private readonly views = new Set<EditorView>();
  private readonly byEditor = new WeakMap<Editor, EditorView>();
  private readonly refresh = StateEffect.define<void>();
  private refreshQueued = false;

  constructor(private readonly enabled: (path: string) => boolean) {}

  viewFor(editor: Editor, path: string): EditorView | undefined {
    const view = this.byEditor.get(editor);
    return view && this.scopedFile(view)?.path === path ? view : undefined;
  }

  invalidate(): void {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    // A snapshot can be invalidated from inside a CodeMirror update.
    queueMicrotask((): void => {
      this.refreshQueued = false;
      for (const view of this.views) view.dispatch({ effects: this.refresh.of(undefined) });
    });
  }

  extension(projects: WritingProjects, suggest: BananaMarkSuggest): Extension {
    const editors = this;
    const scope = new Compartment();
    const inactive: Extension = [];
    const active: Extension = [
      sourceDecorations((view: EditorView, source: string): ReturnType<WritingProjects["current"]> => {
        const path = editors.scopedFile(view)?.path;
        return path === undefined ? null : projects.current(path, source);
      }),
      keymap.of([{
        key: "Ctrl-Space",
        run(view: EditorView): boolean {
          const file = editors.scopedFile(view);
          const editor = view.state.field(editorInfoField, false)?.editor;
          return Boolean(file && editor && suggest.openExplicit(editor, file));
        },
      }]),
      EditorView.domEventObservers({
        compositionstart(_event: CompositionEvent, view: EditorView): void {
          if (suggest.context?.editor === view.state.field(editorInfoField, false)?.editor) suggest.close();
        },
        compositionend(_event: CompositionEvent, view: EditorView): void {
          const path = editors.scopedFile(view)?.path;
          if (path) projects.invalidate(path);
        },
      }),
    ];

    const lifecycle = ViewPlugin.fromClass(class {
      private mounted = true;
      private editor: Editor | undefined;
      private path: string | null = null;

      constructor(private readonly view: EditorView) {
        editors.views.add(view);
        this.sync();
      }

      update(update: ViewUpdate): void {
        this.sync();
        if (update.docChanged && this.path) projects.invalidate(this.path);
      }

      destroy(): void {
        this.mounted = false;
        editors.views.delete(this.view);
        if (this.editor && editors.byEditor.get(this.editor) === this.view) {
          editors.byEditor.delete(this.editor);
          if (suggest.context?.editor === this.editor) suggest.close();
        }
        projects.attach(this.view, null);
      }

      private sync(): void {
        const editor = this.view.state.field(editorInfoField, false)?.editor;
        if (editor !== this.editor) {
          if (this.editor && editors.byEditor.get(this.editor) === this.view) editors.byEditor.delete(this.editor);
          if (editor) editors.byEditor.set(editor, this.view);
          this.editor = editor;
        }
        const nextPath = editors.scopedFile(this.view)?.path ?? null;
        if (this.path !== nextPath) {
          this.path = nextPath;
          if (suggest.context?.editor === editor) suggest.close();
          projects.attach(this.view, nextPath);
        }
        const extension = nextPath ? active : inactive;
        if (scope.get(this.view.state) === extension) return;
        queueMicrotask((): void => {
          if (!this.mounted) return;
          const current = scope.get(this.view.state);
          const next = editors.scopedFile(this.view) ? active : inactive;
          if (current !== undefined && current !== next) this.view.dispatch({ effects: scope.reconfigure(next) });
        });
      }
    });
    return [scope.of(inactive), lifecycle];
  }

  private scopedFile(view: EditorView): TFile | null {
    const file = view.state.field(editorInfoField, false)?.file;
    return file && view.state.field(editorLivePreviewField, false) === false && this.enabled(file.path) ? file : null;
  }
}
