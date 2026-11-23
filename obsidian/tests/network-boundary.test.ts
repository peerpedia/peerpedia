import { tmpdir } from "node:os";
import type { App, Command, Editor, MarkdownFileInfo, PluginManifest, WorkspaceLeaf } from "obsidian";
import { expect, test, vi } from "vitest";

import { NodeTransport } from "../src/remote/transport";
import PeerpediaPlugin from "../src/main";
import { FileSystemAdapter, MarkdownView } from "obsidian";

vi.mock("electron", (): object => ({shell:{}}));
vi.mock("obsidian", (): object => {
  class Host {}
  return {Plugin:Host, Modal:Host, ItemView:Host, TextFileView:Host, EditorSuggest:Host,
    PluginSettingTab:Host, Notice:Host, FileSystemAdapter:class {}, MarkdownView:class {}};
});

test("enabling, opening a chapter, editing and its preview command never request an account", async (): Promise<void> => {
  vi.stubGlobal("__PEERPEDIA_LANGUAGE_WORKER__", "");
  const request = vi.spyOn(NodeTransport.prototype, "request").mockRejectedValue(new Error("unexpected network request"));
  const events = new Map<string, (...args: unknown[]) => void>();
  const on = (name:string, callback:(...args:unknown[]) => void): void => { events.set(name, callback); };
  const commands = new Map<string, Command>();
  const view = Object.assign(Object.create(MarkdownView.prototype), {file:{path:"paper.md",parent:{isRoot:():boolean => true}},editor:{},leaf:{}});
  const setViewState = vi.fn();
  let saved: Record<string,unknown> = {};
  const app = {vault:{configDir:".obsidian", adapter:Object.assign(Object.create(FileSystemAdapter.prototype), {
    getBasePath:():string => tmpdir(), exists:async ():Promise<boolean> => true}), on},
    workspace:{on,getLeavesOfType:():WorkspaceLeaf[] => [], createLeafBySplit:():object => ({setViewState}),
      revealLeaf:vi.fn(), setActiveLeaf:vi.fn()}};
  const plugin = new PeerpediaPlugin(app as unknown as App, {id:"peerpedia"} as PluginManifest);
  Object.assign(plugin, {app,manifest:{id:"peerpedia"},loadData:async ():Promise<object> => saved,
    saveData:async (data:Record<string,unknown>):Promise<void> => { saved = data; },
    registerEvent:vi.fn(),registerView:vi.fn(),addRibbonIcon:vi.fn(),registerEditorExtension:vi.fn(),
    register:vi.fn(),registerEditorSuggest:vi.fn(),addSettingTab:vi.fn(),
    addCommand:(command:Command):void => { commands.set(command.id,command); }});
  try {
    await plugin.onload();
    events.get("active-leaf-change")!({view});
    events.get("editor-change")!({}, {file:view.file});
    await commands.get("preview-paper")!.editorCallback!({} as Editor, view as MarkdownFileInfo);
    expect(setViewState).toHaveBeenCalledWith(expect.objectContaining({type:"peerpedia-paper-preview"}));
    expect(request).not.toHaveBeenCalled();
    expect(commands.has("connect-account")).toBe(true);
    const identity = {origin:"https://peerpedia.dev",username:"writer"};
    await Promise.all([plugin.updateConnection(identity),plugin.updateWritingScope({folders:{"":true},files:{}})]);
    expect(saved).toEqual({connection:identity,writingScope:{folders:{"":true},files:{}}});
    await plugin.updateConnection(null);
    expect(saved).toEqual({writingScope:{folders:{"":true},files:{}}});
  } finally {
    request.mockRestore();
    vi.unstubAllGlobals();
  }
});
