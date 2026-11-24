import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vault } from "obsidian";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { VaultProjectStore } from "../src/host/vault-store";
import { AnchoredFiles } from "../src/project/anchored-files";
import { projectRevision, sourceDigest, type FileChange } from "../src/project/store";
import type { SourceFile } from "../src/project/types";
import { toPublicationDocument } from "../src/project/publication";
import { checkProject } from "../src/remote/controller";
import { PeerpediaApi } from "../src/remote/api";
import { importChanges } from "../src/remote/import";
import { applyMerge, mergeDocuments, prepareMerge, planMergedFiles, resolveMerge } from "../src/remote/merge";
import type { RemoteBinding, RemoteCheck, VerifiedSnapshot } from "../src/remote/types";
import { verifySnapshot } from "../src/remote/verify";
import raw1 from "./fixtures/manifests/v1.json";
import raw3 from "./fixtures/manifests/v3.json";
import raw4 from "./fixtures/manifests/v4.json";

const prior = verifySnapshot(raw3), current = verifySnapshot(raw4);
const origin = "https://fixture.invalid", root = "manuscript";
const binding: RemoteBinding = {schemaVersion:1,origin,paperId:prior.paperId,acceptedBase:current,workingBase:prior,
  checkedAt:"2026-11-23T00:00:00.000Z",lastSubmitted:null,activePr:null};
const events = {} as Pick<Vault,"on"|"offref">;
let vault: string;
let store: VaultProjectStore;
let api: PeerpediaApi;
beforeEach(async (): Promise<void> => {
  vault = await mkdtemp(join(tmpdir(),"peerpedia-merge-"));
  store = new VaultProjectStore(vault,events);
  await store.create(root,importChanges(prior),binding);
  api = new PeerpediaApi(origin,{request:vi.fn()});
  vi.spyOn(api,"current").mockResolvedValue(current);
  vi.spyOn(api,"prs").mockResolvedValue([]);
});
afterEach(async (): Promise<void> => { vi.restoreAllMocks(); await rm(vault,{recursive:true,force:true}); });

test("historical working version is compared even when accepted is current; confirm rechecks both heads and disk", async (): Promise<void> => {
  const project = await store.read(root);
  const comparison = await prepareMerge(project,"accepted",store,api);
  expect(comparison.base?.hash).toBe(prior.hash);
  expect(await store.loadBinding(root)).toEqual(binding);
  const changes = planMergedFiles(project,resolveMerge(comparison.result,{}));
  vi.mocked(api.current).mockResolvedValueOnce(prior);
  await expect(applyMerge(project,changes,comparison.check,store,api)).rejects.toThrow(/重新比较/);
  expect(await store.loadBinding(root)).toEqual(binding);
  await writeFile(join(vault,root,"paper.md"),"external");
  await expect(applyMerge(project,changes,comparison.check,store,api)).rejects.toThrow();
  expect(await readFile(join(vault,root,"paper.md"),"utf8")).toBe("external");
});
test("completed source journal recovers failed binding publication offline, changed files block recovery", async (): Promise<void> => {
  const project = await store.read(root), comparison = await prepareMerge(project,"accepted",store,api);
  const changes = planMergedFiles(project,resolveMerge(comparison.result,{}));
  const rename = AnchoredFiles.prototype.rename;
  const fault = vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this: AnchoredFiles, from: string, to: string, mode: "swap"|"publish"): void {
    if (to.includes("/binding-history/")) throw new Error("fault during binding publish");
    rename.call(this,from,to,mode);
  });
  await expect(applyMerge(project,changes,comparison.check,store,api)).rejects.toThrow();
  fault.mockRestore();
  expect(await store.loadBinding(root)).toEqual(binding);
  const path = join(vault,root,"chapters/intro.md");
  const merged = await readFile(path,"utf8");
  await writeFile(path,"my new edit");
  const reopened = new VaultProjectStore(vault,events);
  await expect(reopened.recoverMerge(root)).rejects.toThrow();
  expect(await reopened.loadBinding(root)).toEqual(binding);
  await writeFile(path,merged);
  await reopened.recoverMerge(root);
  expect((await reopened.loadBinding(root))?.workingBase.hash).toBe(current.hash);
  expect(api.current).toHaveBeenCalledTimes(2);
});

test("new head uses the newest verified ordinal from this proposal and advances only its own axis", async (): Promise<void> => {
  const submitted = verifySnapshot({...raw3,status:"pending"});
  const latest = verifySnapshot({...raw4,status:"pending"});
  const pr = {id:"00000000-0000-0000-0000-000000000abc",owner:"writer",submissionId:submitted.submissionId,hash:submitted.hash,status:"pending" as const};
  const head = {...pr,submissionId:latest.submissionId,hash:latest.hash};
  const bound = {...binding,acceptedBase:prior,workingBase:submitted,lastSubmitted:submitted,activePr:pr};
  await store.saveBinding(root,bound,(await store.readBindingVersion(root)).digest);
  vi.mocked(api.prs).mockResolvedValue([head]);
  const snapshot = vi.spyOn(api,"proposalSnapshot").mockImplementation(async (id:string):Promise<Awaited<ReturnType<PeerpediaApi["proposalSnapshot"]>>> =>
    id === latest.submissionId ? {snapshot:latest,proposal:{id:pr.id,number:3}} : {snapshot:submitted,proposal:{id:pr.id,number:1}});
  const project = await store.read(root), comparison = await prepareMerge(project,"proposal",store,api);
  expect(comparison.base).toEqual(submitted);
  expect(await store.loadBinding(root)).toEqual(bound);
  const changes = planMergedFiles(project,resolveMerge(comparison.result,{}));
  vi.mocked(api.prs).mockResolvedValueOnce([{...head,status:"withdrawn"}]);
  await expect(applyMerge(project,changes,comparison.check,store,api)).rejects.toThrow(/重新比较/);
  expect(await store.loadBinding(root)).toEqual(bound);
  await applyMerge(project,changes,comparison.check,store,api);
  expect(await store.loadBinding(root)).toMatchObject({acceptedBase:prior,workingBase:latest,lastSubmitted:submitted,activePr:head});
  expect(snapshot.mock.calls.map(([id]:[string]):string => id)).toEqual([latest.submissionId,submitted.submissionId]);
});

test("unproved historic ancestry requires manual choices and a wrong proposal receipt cannot authorize a head", async (): Promise<void> => {
  const submitted = verifySnapshot({...raw3,status:"superseded"}), latest = verifySnapshot({...raw4,status:"pending"});
  const pr = {id:"00000000-0000-0000-0000-000000000abc",owner:"writer",submissionId:latest.submissionId,hash:latest.hash,status:"pending" as const};
  const bound = {...binding,workingBase:submitted,lastSubmitted:null,activePr:pr};
  await store.saveBinding(root,bound,(await store.readBindingVersion(root)).digest);
  vi.mocked(api.prs).mockResolvedValue([pr]);
  const exact = vi.spyOn(api,"proposalSnapshot").mockImplementation(async (id:string):Promise<Awaited<ReturnType<PeerpediaApi["proposalSnapshot"]>>> =>
    id === latest.submissionId ? {snapshot:latest,proposal:{id:pr.id,number:3}} : {snapshot:submitted,proposal:{id:pr.id,number:4}});
  const project = await store.read(root), comparison = await prepareMerge(project,"proposal",store,api);
  expect(comparison.base).toBeNull();
  expect(comparison.result.conflicts.length).toBeGreaterThan(0);
  expect((): unknown => resolveMerge(comparison.result,{})).toThrow();
  await expect(applyMerge(project,[],comparison.check,store,api)).rejects.toThrow();
  exact.mockResolvedValueOnce({snapshot:latest,proposal:{id:latest.paperId,number:3}});
  await expect(prepareMerge(project,"proposal",store,api)).rejects.toThrow(/提案版本/);
  expect(await store.loadBinding(root)).toEqual(bound);
});

test("acceptance of the submitted proposal retains edits made locally since submitting", async (): Promise<void> => {
  const submitted = verifySnapshot({...raw3,status:"pending"});
  const bound = {...binding,workingBase:prior,lastSubmitted:submitted};
  await store.saveBinding(root,bound,(await store.readBindingVersion(root)).digest);
  vi.mocked(api.current).mockResolvedValue(prior);
  vi.spyOn(api,"proposalSnapshot").mockResolvedValue({snapshot:prior,proposal:null});
  await writeFile(join(vault,root,"paper.md"),"my later edit");
  const project = await store.read(root), comparison = await prepareMerge(project,"accepted",store,api);
  expect(comparison.base).toEqual(submitted);
  const changes = planMergedFiles(project,resolveMerge(comparison.result,{}));
  await applyMerge(project,changes,comparison.check,store,api);
  expect(await readFile(join(vault,root,"paper.md"),"utf8")).toBe("my later edit");
  expect(await store.loadBinding(root)).toMatchObject({workingBase:prior,lastSubmitted:submitted});
});

test("an unsaved buffer and a cancel in the confirm recheck both precede intent publication", async (): Promise<void> => {
  const native = new VaultProjectStore(vault,events,{buffers:(path:string):readonly string[] => path.endsWith("paper.md") ? ["unsaved in pane"] : []});
  const project = await native.read(root), comparison = await prepareMerge(project,"accepted",native,api);
  const changes = planMergedFiles(project,resolveMerge(comparison.result,{}));
  await expect(applyMerge(project,changes,comparison.check,native,api,():boolean => false)).rejects.toThrow(/已取消/);
  expect((await native.recovery(root)).length).toBe(0);
  await expect(applyMerge(project,changes,comparison.check,native,api)).rejects.toThrow(/尚未保存/);
  expect((await native.readBindingVersion(root)).pendingMerge).toBe(false);
  expect((await native.read(root)).revision).toEqual(project.revision);
});

test("restart before journal or after partial files never advances the baseline", async (): Promise<void> => {
  const project = await store.read(root);
  const comparison = await prepareMerge(project,"accepted",store,api);
  const changes = planMergedFiles(project,resolveMerge(comparison.result,{}));
  const file = AnchoredFiles.prototype.file;
  const first = vi.spyOn(AnchoredFiles.prototype,"file").mockImplementation(async function(this:AnchoredFiles,path:string,body:string,mode?:number):Promise<void> {
    if (path.endsWith("/journal.json")) throw new Error("fixture before source journal");
    await file.call(this,path,body,mode);
  });
  await expect(applyMerge(project,changes,comparison.check,store,api)).rejects.toThrow();
  first.mockRestore();
  const reopened = new VaultProjectStore(vault,events);
  expect((await reopened.readBindingVersion(root)).pendingMerge).toBe(true);
  await reopened.recoverMerge(root);
  expect(await reopened.loadBinding(root)).toEqual(binding);
  expect((await reopened.readBindingVersion(root)).pendingMerge).toBe(false);
  const rename = AnchoredFiles.prototype.rename;
  const fault = vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this:AnchoredFiles,from:string,to:string,mode:"swap"|"publish"):void {
    if (to.endsWith("/chapters/results.md")) throw new Error("fixture second chapter fault");
    rename.call(this,from,to,mode);
  });
  await expect(applyMerge(project,changes,comparison.check,reopened,api)).rejects.toThrow();
  fault.mockRestore();
  // Manifest last: first created chapter is still outside the original membership.
  expect(await readFile(join(vault,root,"chapters/intro.md"),"utf8")).toBe(current.document.chapters[0].markdown);
  await expect(reopened.recoverMerge(root)).rejects.toThrow(/部分写入/);
  expect((await reopened.readBindingVersion(root)).pendingMerge).toBe(true);
  expect(await reopened.loadBinding(root)).toEqual(binding);
  expect((await reopened.recovery(root)).length).toBeGreaterThan(0);
});

function version(n: number, markdown: string, base: VerifiedSnapshot, status: VerifiedSnapshot["status"]): VerifiedSnapshot {
  const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
  const manifest = {...raw1.manifest,base_hash:base.hash,submission_id:"00000000-0000-0000-0000-"+String(n).padStart(12,"0"),
    markdown_sha256:sha(markdown)};
  return verifySnapshot({...raw1,status,markdown,manifest,snapshot_identifier:null,hash:sha(JSON.stringify(manifest,Object.keys(manifest).sort()))});
}

test("after an accepted merge the last incorporated PR snapshot outranks the older last submission", async (): Promise<void> => {
  const accepted = verifySnapshot(raw1);
  const submitted = version(200,"first\nshared\nend",accepted,"pending");
  const incorporated = version(201,"middle\nshared\nend",accepted,"pending");
  const nextAccepted = version(202,accepted.document.markdown,accepted,"accepted");
  const latest = version(203,"middle\nshared\nnext",accepted,"pending");
  const pr = {id:"00000000-0000-0000-0000-000000000abc",owner:"writer",submissionId:incorporated.submissionId,hash:incorporated.hash,status:"pending" as const};
  const bookRoot = "cross";
  const setup = {...binding,acceptedBase:accepted,workingBase:incorporated,lastSubmitted:submitted,activePr:pr};
  const book = await store.create(bookRoot,importChanges(incorporated),setup);
  vi.mocked(api.current).mockResolvedValue(nextAccepted);
  vi.mocked(api.prs).mockResolvedValue([{...pr,submissionId:latest.submissionId,hash:latest.hash}]);
  const comparison = await prepareMerge(book,"accepted",store,api);
  expect(comparison.base?.hash).toBe(accepted.hash);
  await applyMerge(book,planMergedFiles(book,resolveMerge(comparison.result,{})),comparison.check,store,api);
  await writeFile(join(vault,bookRoot,"paper.md"),"my later edit\nshared\nend");
  expect((await store.loadBinding(bookRoot))?.workingBase.hash).toBe(nextAccepted.hash);
  const versions = [submitted,incorporated,latest];
  vi.spyOn(api,"proposalSnapshot").mockImplementation(async (id: string): Promise<Awaited<ReturnType<PeerpediaApi["proposalSnapshot"]>>> => {
    const i = versions.findIndex((v: VerifiedSnapshot): boolean => v.submissionId === id);
    return {snapshot:versions[i],proposal:{id:pr.id,number:i+1}};
  });
  const project = await store.read(bookRoot), update = await prepareMerge(project,"proposal",store,api);
  expect(update.base?.hash).toBe(incorporated.hash);
  expect(update.result.conflicts).toEqual([]);
  const merged = resolveMerge(update.result,{});
  expect(merged.markdown).toBe("my later edit\nshared\nnext");
  await applyMerge(project,planMergedFiles(project,merged),update.check,store,api);
  expect(await store.loadBinding(bookRoot)).toMatchObject({acceptedBase:nextAccepted,workingBase:latest,lastSubmitted:submitted});
});

test("restart after binding commit verifies its exact successor before closing the same intent", async (): Promise<void> => {
  const project = await store.read(root), comparison = await prepareMerge(project,"accepted",store,api);
  const changes = planMergedFiles(project,resolveMerge(comparison.result,{}));
  const rename = AnchoredFiles.prototype.rename;
  const fault = vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this: AnchoredFiles,from:string,to:string,mode:"swap"|"publish"):void {
    if (from.endsWith("/merge-pending.json")) throw new Error("fixture before intent archive");
    rename.call(this,from,to,mode);
  });
  await expect(applyMerge(project,changes,comparison.check,store,api)).rejects.toThrow();
  fault.mockRestore();
  const first = await store.readBindingVersion(root);
  expect(first).toMatchObject({pendingMerge:true,binding:{workingBase:current}});
  await expect(store.saveBinding(root,binding,first.digest)).rejects.toThrow(/合并/);
  const reopened = new VaultProjectStore(vault,events);
  await reopened.recoverMerge(root);
  expect(await reopened.readBindingVersion(root)).toMatchObject({pendingMerge:false,digest:first.digest});
});

declare const __PEERPEDIA_ANCHORED__: string;
test.each([false,true])("another process cannot recover a live pre-journal writer; kill=%s", async (kill: boolean): Promise<void> => {
  const project = await store.read(root);
  const path = "paper.md", body = "user confirmed merged source";
  const changes: FileChange[] = [{path,beforeDigest:project.files.find((f: SourceFile): boolean => f.path === path)!.digest,afterText:body}];
  const nextRevision = projectRevision(project.files.map((f: SourceFile):SourceFile => f.path === path ?
    {...f,text:body,digest:sourceDigest(Buffer.from(body))} : f));
  const data = join(vault,"worker.json");
  const next = {...binding,workingBase:current};
  await writeFile(data,JSON.stringify({vault,root,revision:project.revision,changes,merge:{expectedDigest:(await store.readBindingVersion(root)).digest,binding:next,revision:nextRevision}}));
  const child: ChildProcess = fork(fileURLToPath(new URL("./fixtures/merge-writer.ts",import.meta.url)),[data],{
    execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"],env:{...process.env,PEERPEDIA_TEST_ANCHORED:__PEERPEDIA_ANCHORED__}});
  const exited = once(child,"exit");
  let errors = "";
  child.stderr!.on("data",(chunk: Buffer): void => { errors += chunk.toString(); });
  try {
    const ready = await Promise.race([once(child,"message"),exited]);
    expect(ready,errors).toEqual(["before-journal",undefined]);
    expect((await store.readBindingVersion(root)).pendingMerge).toBe(true);
    await expect(store.recoverMerge(root)).rejects.toThrow(/正在|占用/);
    expect((await store.readBindingVersion(root)).pendingMerge).toBe(true);
    if (kill) child.kill("SIGKILL");
    else child.send("resume");
    await exited;
    if (kill) await store.recoverMerge(root);
    expect(await store.loadBinding(root)).toEqual(kill ? binding : next);
    expect((await store.read(root)).revision).toBe(kill ? project.revision : nextRevision);
    expect((await store.readBindingVersion(root)).pendingMerge).toBe(false);
  } finally { child.kill("SIGKILL"); await exited; }
});

test("a status-only writer paused just before publication excludes merge and preserves its CAS", async (): Promise<void> => {
  const project = await store.read(root), comparison = await prepareMerge(project,"accepted",store,api);
  const changes = planMergedFiles(project,resolveMerge(comparison.result,{}));
  let pause!: () => void, resume!: () => void;
  const paused = new Promise<void>((resolve: () => void): void => { pause = resolve; });
  const resumed = new Promise<void>((resolve: () => void): void => { resume = resolve; });
  const file = AnchoredFiles.prototype.file;
  let first = true;
  let checked: Promise<RemoteCheck>;
  vi.spyOn(AnchoredFiles.prototype,"file").mockImplementation(async function(this: AnchoredFiles,path: string,body: string,mode?:number): Promise<void> {
    await file.call(this,path,body,mode);
    if (first && path.includes("/.binding-")) { first = false; pause(); await resumed; }
    // On the unfixed writer, allow the paused timestamp to publish after
    // merge intent acquisition but before the first manuscript replacement.
    if (path.endsWith("/journal.json")) { resume(); await checked; }
  });
  checked = checkProject(root,api,new VaultProjectStore(vault,events));
  await paused;
  try {
    await expect(applyMerge(project,changes,comparison.check,store,api)).rejects.toThrow(/正在|占用/);
    expect((await store.read(root)).revision).toBe(project.revision);
    expect((await store.readBindingVersion(root)).pendingMerge).toBe(false);
  } finally { resume(); await checked; }
  await expect(applyMerge(project,changes,comparison.check,store,api)).rejects.toThrow(/重新比较/);
  const fresh = await prepareMerge(project,"accepted",store,api);
  await applyMerge(project,planMergedFiles(project,resolveMerge(fresh.result,{})),fresh.check,store,api);
  expect(await store.loadBinding(root)).toMatchObject({workingBase:current});
});

test("accepted merge retains superseded historical proposal source and leaves newer head outstanding across reopen", async (): Promise<void> => {
  const parent = verifySnapshot(raw1);
  const historic = version(310,"old\nshared\nend",parent,"superseded");
  const accepted = version(311,parent.document.markdown,parent,"accepted");
  const newer = version(312,"old\nshared\nremote",parent,"pending");
  const head = {id:"00000000-0000-0000-0000-000000000abc",owner:"writer",submissionId:newer.submissionId,hash:newer.hash,status:"pending" as const};
  const bookRoot = "historical";
  const initial = {...binding,acceptedBase:parent,workingBase:historic};
  const book = await store.create(bookRoot,importChanges(historic),initial);
  vi.mocked(api.current).mockResolvedValue(accepted);
  vi.mocked(api.prs).mockResolvedValue([head]);
  let ordinal = 2;
  vi.spyOn(api,"proposalSnapshot").mockImplementation(async (id:string):Promise<Awaited<ReturnType<PeerpediaApi["proposalSnapshot"]>>> =>
    id === historic.submissionId ? {snapshot:historic,proposal:{id:head.id,number:ordinal}} : {snapshot:newer,proposal:{id:head.id,number:4}});
  const acceptedUpdate = await prepareMerge(book,"accepted",store,api);
  expect(acceptedUpdate.check.activePr).toEqual(head);
  expect(await store.loadBinding(bookRoot)).toEqual(initial);
  await applyMerge(book,planMergedFiles(book,resolveMerge(acceptedUpdate.result,{})),acceptedUpdate.check,store,api);
  expect(await store.loadBinding(bookRoot)).toMatchObject({workingBase:accepted,acceptedBase:accepted,activePr:null,lastSubmitted:null,proposalSource:{id:head.id,number:2,snapshot:historic}});
  await writeFile(join(vault,bookRoot,"paper.md"),"my edit\nshared\nend");
  const project = await store.read(bookRoot);
  const now = await prepareMerge(project,"proposal",store,api);
  expect(now.base?.hash).toBe(historic.hash);
  const reopened = new VaultProjectStore(vault,events);
  ordinal = 3;
  expect((await prepareMerge(project,"proposal",reopened,api)).base).toBeNull();
  ordinal = 2;
  const again = await prepareMerge(project,"proposal",reopened,api);
  expect(again.base?.hash).toBe(historic.hash);
  const merge = resolveMerge(again.result,{});
  expect(merge.markdown).toBe("my edit\nshared\nremote");
  await applyMerge(project,planMergedFiles(project,merge),again.check,reopened,api);
  const completed = await reopened.loadBinding(bookRoot);
  expect(completed).toMatchObject({acceptedBase:accepted,workingBase:newer,activePr:head,lastSubmitted:null});
  expect(completed?.proposalSource).toBeUndefined();
});

test("case-colliding remote addition is applicable without touching the local member's old file", async ():Promise<void> => {
  const project = await store.create("case-book",importChanges(current));
  const base = toPublicationDocument(project);
  const ch = (id:string): {id:string;title:string;markdown:string} => ({id,title:id,markdown:"# "+id+"\n"});
  const left = ch("Appendix"), right = ch("appendix");
  const edited = await store.apply(project.root,project.revision,planMergedFiles(project,{...base,chapters:[...base.chapters,left]}));
  const m = mergeDocuments(base,toPublicationDocument(edited),{...base,chapters:[...base.chapters,right]});
  expect(m.conflicts).toHaveLength(1);
  const choice = m.conflicts[0];
  const done = await store.apply(project.root,edited.revision,planMergedFiles(edited,resolveMerge(m,{[choice.id]:choice.remote})));
  expect(toPublicationDocument(done).chapters.at(-1)).toEqual(right);
  expect(await readFile(join(vault,project.root,"chapters/Appendix.md"),"utf8")).toBe(left.markdown);
});
