import { MarkdownView, type Editor, type WorkspaceLeaf } from "obsidian";
import { expect, test, vi } from "vitest";
import type { RenderPage, SourceTarget } from "../renderer/protocol";
import { PreviewView } from "../src/ui/preview-view";
import { projectFixture } from "./fixtures";

vi.mock("obsidian", (): Record<string, new () => object> => ({
  ItemView: class {}, MarkdownView: class {}, Modal: class {},
}));
vi.mock("electron", (): {shell: object} => ({shell: {}}));

test("manual preview browsing persists through ordinary notifications but source reactivation restores the same cursor", (): void => {
  const project = projectFixture();
  const first: SourceTarget = {chapterId:"intro", id:"intro", source:"chapter", kind:"heading", from:0, to:12};
  const pages: RenderPage[] = [
    {id:"intro", title:"Introduction", html:"", targets:[first]},
    {id:"proof", title:"Proof", html:"", targets:[]},
  ];
  const reader = {show: vi.fn((_page: RenderPage): void => {}), scroll: vi.fn((_id: string | null): boolean => true)};
  // The mounted host ports are the only doubles. The view's real editor and link handlers share the follow cache.
  const view: PreviewView = Object.assign(Object.create(PreviewView.prototype), {
    project, disk:project, reader, shown:{id:"one", revision:project.revision, pages}, chapters:{}, position:{},
  });
  const path = "paper/chapters/z-intro.md";
  const editor = {getCursor: (): {line: number; ch: number} => ({line:0,ch:2}), posToOffset: (): number => 2} as unknown as Editor;
  const native = Object.assign(Object.create(MarkdownView.prototype), {file:{path},editor});
  const leaf = {view:native} as WorkspaceLeaf;
  view.editorMoved(leaf, editor, path, false, true);
  expect(reader.show).toHaveBeenLastCalledWith(pages[0]);
  view["openLink"]("?chapter=proof");
  view.editorMoved(leaf, editor, path, false, true);
  expect(reader.show).toHaveBeenLastCalledWith(pages[1]);
  view.editorMoved(leaf, editor, path, false, true, true);
  expect(reader.show).toHaveBeenLastCalledWith(pages[0]);
  expect(reader.scroll).toHaveBeenLastCalledWith("intro", true);
});
