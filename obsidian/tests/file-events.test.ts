import type { App, Editor } from "obsidian";
import { expect, test } from "vitest";
import { stageChapter } from "../src/host/file-events";

test("a draft captured during scope migration survives the original pane being emptied", async (): Promise<void> => {
  const source = {path: "paper/old.md"}, target = {path: "paper/new.md"};
  let text = "原稿";
  const editor = {
    getValue: (): string => text, listSelections: (): never[] => [],
    getScrollInfo: (): {left: number; top: number} => ({left: 0, top: 0}),
    setSelections: (): void => {}, scrollTo: (): void => {},
  };
  const pane = {file: source, editor, getViewType: (): string => "markdown"};
  const leaf = {
    view: pane as unknown, getViewState: (): {state: object} => ({state: {}}),
    openFile: async (): Promise<void> => { leaf.view = {...pane, file: target}; },
    loadIfDeferred: async (): Promise<void> => {},
  };
  let listener: ((editor: Editor) => void) | undefined;
  const app = {workspace: {
    getLeavesOfType: (): (typeof leaf)[] => [leaf],
    on: (_event: string, callback: (e: Editor) => void): object => { listener = callback; return {}; },
    offref: (): void => { listener = undefined; },
    iterateAllLeaves: (callback: (l: typeof leaf) => void): void => callback(leaf),
  }, vault: {getFileByPath: (path: string): typeof source => path === source.path ? source : target}} as unknown as App;
  const move = await stageChapter(app, source.path, async (_from: string, _to: string): Promise<void> => {
    await Promise.resolve();
    text = "重接期间的输入";
    listener!(editor as unknown as Editor);
    leaf.view = {getViewType: (): string => "empty"};
  });
  try {
    await expect(move.reconnect(target.path)).rejects.toThrow(/编辑器/);
    expect(move.drafts?.()).toEqual(["重接期间的输入"]);
  } finally { move.dispose?.(); }
  expect(listener).toBeUndefined();
});
