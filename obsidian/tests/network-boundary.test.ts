import { tmpdir } from "node:os";
import type { App, Command, Editor, MarkdownFileInfo, PluginManifest, WorkspaceLeaf } from "obsidian";
import { expect, test, vi } from "vitest";

import { DeviceCredentials } from "../src/remote/credentials";
import { ConnectionModal } from "../src/ui/connection-modal";
import type { AccountIdentity, HttpResponse, Transport } from "../src/remote/types";
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
    await plugin.updateConnection(null, [identity]);
    expect(saved).toEqual({connectionCleanup:[identity],writingScope:{folders:{"":true},files:{}}});
    await plugin.updateConnection(null, []);
    expect(saved).toEqual({writingScope:{folders:{"":true},files:{}}});
  } finally {
    request.mockRestore();
    vi.unstubAllGlobals();
  }
});

interface TestElement {
  tag: string; text?: string; type?: string; value: string; disabled: boolean; onclick?: () => void;
  createEl: (tag: string, options: {text?:string; type?:string}) => TestElement;
}

function openModal(identity: AccountIdentity | null, pending: readonly AccountIdentity[], store: DeviceCredentials, transport: Transport,
  save: (active: AccountIdentity | null, cleanup: readonly AccountIdentity[]) => Promise<void>): (name: string) => TestElement {
  const elements: TestElement[] = [];
  const createEl = (tag:string, options:{text?:string;type?:string}):TestElement => {
    const element = {tag,...options,value:"",disabled:false,createEl};
    elements.push(element);
    return element;
  };
  const modal = new ConnectionModal({} as App,identity,transport,store,save,pending);
  Object.assign(modal,{setTitle:vi.fn(),contentEl:{empty:():void => { elements.length = 0; },createEl}});
  modal.onOpen();
  return (name:string):TestElement => {
    const element = elements.find((item:TestElement):boolean => item.type === name || item.text?.includes(name) === true);
    if (!element) throw new Error("Missing control " + name);
    return element;
  };
}

test("a failed native disconnect frees the modal for a new account and preserves targeted retry across restart", async (): Promise<void> => {
  const first = {origin:"https://one.invalid",username:"first"};
  const second = {origin:"https://two.invalid",username:"second"};
  let state: {active:AccountIdentity|null; cleanup:readonly AccountIdentity[]} = {active:null,cleanup:[]};
  const save = async (active:AccountIdentity|null,cleanup:readonly AccountIdentity[]):Promise<void> => { state = {active,cleanup}; };
  const transport: Transport = {request:vi.fn(async (origin:string):Promise<HttpResponse> => ({status:200,headers:{},body:Buffer.from(JSON.stringify({
    username:origin === first.origin ? first.username : second.username,scopes:["propose"],expires_at:"2030-01-01T00:00:00Z",
    agreement:{url:"/agreements/",accepted:false,version:"v1"},
  }))}))};
  const store = new DeviceCredentials("/nonexistent-peerpedia-helper");
  const remove = vi.spyOn(store,"remove");
  let control = openModal(null,[],store,transport,save);
  control("url").value = first.origin;
  control("password").value = "temporary-one";
  control("Connect and verify account").onclick!();
  await vi.waitFor(():void => { expect(control("The token is available for this session only").tag).toBe("p"); });
  control("Disconnect and remove").onclick!();
  await vi.waitFor(():void => { expect(state).toEqual({active:null,cleanup:[first]}); });
  await expect(store.read(first.origin,first.username)).rejects.toThrow();
  control = openModal(state.active,state.cleanup,store,transport,save);
  expect(control("url").disabled).toBe(false);
  expect(control("Keychain removal pending").text).toContain(first.username);
  control("url").value = second.origin;
  control("password").value = "temporary-two";
  control("Connect and verify account").onclick!();
  await vi.waitFor(():void => { expect(control("The token is available for this session only").tag).toBe("p"); });
  expect(state).toEqual({active:second,cleanup:[first]});
  control("Retry removing").onclick!();
  await vi.waitFor(():void => { expect(remove).toHaveBeenCalledTimes(2); expect(control("Retry removing").disabled).toBe(false); });
  expect(remove).toHaveBeenLastCalledWith(first.origin,first.username);
  expect(await store.read(second.origin,second.username)).toBe("temporary-two");
  expect(transport.request).toHaveBeenCalledTimes(2);
});

test("the modal shows the settings failure without claiming a verified or stored first credential", async ():Promise<void> => {
  const store = new DeviceCredentials("/nonexistent-peerpedia-helper");
  const write = vi.spyOn(store,"write");
  const transport:Transport = {request:vi.fn(async ():Promise<HttpResponse> => ({status:200,headers:{},body:Buffer.from(JSON.stringify({
    username:"first",scopes:["propose"],expires_at:"2030-01-01T00:00:00Z",agreement:{url:"/a/",accepted:false,version:"1"},
  }))}))};
  const control = openModal(null,[],store,transport,async ():Promise<void> => { throw new Error("settings unavailable"); });
  control("password").value = "temporary-token";
  control("Connect and verify account").onclick!();
  await vi.waitFor(():void => { expect(control("Unable to save the account settings").tag).toBe("p"); });
  expect(write).not.toHaveBeenCalled();
  expect(control("url").disabled).toBe(false);
  expect(():TestElement => control("Permissions:")).toThrow(/Missing control/);
});

import { ProjectPanel } from "../src/ui/project-panel";
import type { VaultProjectStore } from "../src/host/vault-store";
import type { SubmissionController } from "../src/remote/controller";

test("reopening an unreadable manuscript renders the saved request action from its root",async ():Promise<void>=>{
  vi.stubGlobal("__PEERPEDIA_LANGUAGE_WORKER__", "");
  const controls:string[]=[];
  const store = {readBindingVersion:vi.fn().mockResolvedValue({pendingSubmission:true}),recovery:vi.fn().mockResolvedValue([]),
    watch:vi.fn(),read:vi.fn().mockRejectedValue(new Error("invalid paper.json"))};
  const panel = new ProjectPanel({} as WorkspaceLeaf,store as unknown as VaultProjectStore,vi.fn(),vi.fn(),{request:vi.fn()},"plugins/peerpedia",{} as SubmissionController);
  const content = {empty:():void=>{controls.length=0;},addClass:vi.fn(),createDiv:():unknown=>content,
    createEl:(tag:string,options:{text?:string}):object=>{if (tag==="button") controls.push(options.text!); return {};}};
  Object.assign(panel,{contentEl:content});
  try {
    await panel.selectRoot("paper");
    expect(controls).toContain("Review pending submission");
    expect(controls).not.toContain("Submit to Peerpedia");
    store.readBindingVersion.mockResolvedValue({pendingSubmission:false});
    await panel.selectRoot("paper");
    expect(controls).not.toContain("Review pending submission");
    expect(controls).not.toContain("Submit to Peerpedia");
  } finally {vi.unstubAllGlobals();}
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "obsidian";
import { VaultProjectStore as NativeStore } from "../src/host/vault-store";
import { account,binding as bindingFixture,details,project,root,snapshot } from "./fixtures/publishing";
import { importChanges } from "../src/remote/import";
import { prepareSubmission } from "../src/remote/submit";
import type { ProjectSnapshot, SourceFile } from "../src/project/types";
import { SubmitModal } from "../src/ui/submit-modal";

test("the pending dialog offers explicit original-request replay when its receipt cannot verify",async ():Promise<void>=>{
  const temporary = await mkdtemp(join(tmpdir(),"peerpedia-repair-ui-"));
  try {
    const store = new NativeStore(temporary,{} as Pick<Vault,"on"|"offref">);
    await store.create(root,importChanges(snapshot));
    const request = prepareSubmission(project,null,account,"publish",details);
    await store.submissions.persistRequest(root,request);
    await writeFile(join(temporary,root,".peerpedia-obsidian/submit-"+request.id+"-receipt.json"),"truncated");
    const buttons = new Map<string,{onclick?:()=>void}>();
    const content = {empty:():void=>buttons.clear(),setText:vi.fn(),createEl:(tag:string,options:{text?:string}):object=>{
      const node:{onclick?:()=>void} = {};
      if (tag==="button") buttons.set(options.text!,node);
      return Object.assign(node,{createEl:content.createEl});
    }};
    const retry = vi.fn().mockResolvedValue(snapshot), updated = vi.fn();
    const modal:SubmitModal = Object.assign(Object.create(SubmitModal.prototype),{root,store,controller:{retry},updated,contentEl:content,abort:new AbortController()});
    modal.onOpen();
    await vi.waitFor(():void=>{expect(buttons.has("Retry saved submission")).toBe(true);});
    expect(buttons.has("Finish from saved receipt")).toBe(false);
    expect(retry).not.toHaveBeenCalled();
    buttons.get("Retry saved submission")!.onclick!();
    await vi.waitFor(():void=>{expect(updated).toHaveBeenCalledOnce();});
    expect(retry).toHaveBeenCalledExactlyOnceWith(root,request);
    modal.onClose();
  } finally { await rm(temporary,{recursive:true,force:true}); }
});

test("the panel compares publication content with the working version across layouts and missing files", (): void => {
  const text:string[] = [];
  const panel = Object.assign(Object.create(ProjectPanel.prototype), {
    binding:{binding:{...bindingFixture,acceptedBase:{...snapshot,document:{...snapshot.document,title:"Another accepted title"}}},
      digest:"current",pendingSubmission:true},
    contentEl:{createDiv:(): object => ({createEl:(_tag:string,options:{text:string}): void => { text.push(options.text); }})},
  });
  const local = structuredClone(project);
  const path = local.config.chapters![0].file;
  local.config.chapters![0].file = "chapters/local-intro.md";
  local.config.title = "  " + local.config.title + " ";
  local.files.find((file:SourceFile):boolean => file.path === path)!.path = local.config.chapters![0].file;
  local.revision = "different-file-revision";
  function assertStatus(paper:ProjectSnapshot, expected:string): void {
    text.length = 0;
    panel.renderRemote(paper);
    expect(text).toContain("Local files: " + expected);
  }
  assertStatus(local,"Match the working version");
  for (const field of ["title","authors","abstract","primary_category","license"] as const) {
    assertStatus({...local,config:{...local.config,[field]:"different"}},"Changed");
  }
  assertStatus({...local,config:{...local.config,chapters:[...local.config.chapters!].reverse()}},"Changed");
  assertStatus({...local,files:local.files.map((file:SourceFile):SourceFile =>
    file.path === local.config.bibliography ? {...file,text:file.text+"\n"} : file)},"Changed");
  assertStatus({...local,files:local.files.slice(1)},"Unavailable (source file missing)");
});
