import {
  autocompletion,
  closeCompletion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";

import { probeCompletions } from "../language/probe";

export function createSourceExtension(enabled: (path: string) => boolean): Extension {
  function inScope(state: EditorState): boolean {
    const path = state.field(editorInfoField, false)?.file?.path;
    return path !== undefined && state.field(editorLivePreviewField, false) === false && enabled(path);
  }

  function complete(context: CompletionContext): CompletionResult | null {
    const { state, pos, view } = context;
    if (
      !inScope(state) || state.readOnly
      || state.selection.ranges.length !== 1 || !state.selection.main.empty
    ) {
      return null;
    }

    const line = state.doc.lineAt(pos);
    const labels = probeCompletions(line.text, pos - line.from, view?.compositionStarted ?? false);
    const prefix = context.matchBefore(/[a-z]+/);
    if (!labels.length || !prefix) {
      return null;
    }

    return {
      from: prefix.from,
      options: labels.map((label: string): { label: string } => ({ label })),
    };
  }

  const completionScope = new Compartment();
  const inactive: Extension = [];
  const active: Extension = [
    autocompletion(),
    EditorState.languageData.of((): readonly { autocomplete: CompletionSource }[] => [
      { autocomplete: complete },
    ]),
    EditorView.domEventObservers({
      compositionstart(_event: CompositionEvent, view: EditorView): void {
        if (inScope(view.state)) {
          closeCompletion(view);
        }
      },
    }),
  ];

  function extensionFor(state: EditorState): Extension {
    return inScope(state) ? active : inactive;
  }

  const scope = ViewPlugin.fromClass(class {
    private mounted = true;

    constructor(view: EditorView) {
      this.refresh(view);
    }

    update(update: ViewUpdate): void {
      this.refresh(update.view);
    }

    destroy(): void {
      this.mounted = false;
    }

    private refresh(view: EditorView): void {
      if (completionScope.get(view.state) === extensionFor(view.state)) {
        return;
      }

      // CodeMirror forbids dispatch while a view plugin is being updated.
      queueMicrotask((): void => {
        const current = completionScope.get(view.state);
        const next = extensionFor(view.state);
        if (this.mounted && current !== undefined && current !== next) {
          view.dispatch({ effects: completionScope.reconfigure(next) });
        }
      });
    }
  });

  return [completionScope.of(inactive), scope];
}
