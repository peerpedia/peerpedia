import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { App } from "obsidian";
import { expect, test, vi } from "vitest";

import { WritingProjects } from "../src/host/writing-projects";
import { analyzeWriting, type WritingAnalysis } from "../src/language/analysis";
import type { ProjectSnapshot } from "../src/project/types";

vi.mock("obsidian", (): { MarkdownView: new () => object } => ({
  MarkdownView: class {},
}));

interface TestWorker {
  run(kind: "analyze", project: ProjectSnapshot): Promise<WritingAnalysis>;
  dispose(): void;
}

vi.mock("../src/host/language-worker", (): { LanguageWorker: new () => TestWorker } => ({
  LanguageWorker: class {
    async run(_kind: "analyze", project: ProjectSnapshot): Promise<WritingAnalysis> {
      return analyzeWriting(project, new Map());
    }
    dispose(): void {}
  },
}));

test("one completed chapter analysis belongs to both views of its current document", async (): Promise<void> => {
  const path = "standalone.md";
  const source = "# Same note\n\nSee @not-defined.\n";
  const left = { state: EditorState.create({ doc: source }), compositionStarted: false } as unknown as EditorView;
  const right = { state: EditorState.create({ doc: source }), compositionStarted: false } as unknown as EditorView;
  expect(left.state.doc).not.toBe(right.state.doc);

  // Neither buffer has a paper.json; the view state supplies each standalone document.
  const app = { vault: {}, workspace: { getLeavesOfType: (): [] => [] } } as unknown as App;
  const projects = new WritingProjects(app, "/nonexistent-peerpedia-vault", (): void => {});
  try {
    projects.attach(left, path);
    projects.attach(right, path);
    await vi.waitFor((): void => {
      expect(projects.current(left)?.chapter.diagnostics[0]?.message).toEqual(expect.stringContaining("not-defined"));
      expect(projects.current(right)?.chapter.diagnostics[0]?.message).toEqual(expect.stringContaining("not-defined"));
    });
    projects.attach(right, null);
    expect(projects.current(right)).toBeNull();
    await vi.waitFor((): void => {
      expect(projects.current(left)?.chapter.diagnostics[0]?.message).toEqual(expect.stringContaining("not-defined"));
    });
  } finally {
    projects.dispose();
  }
});
