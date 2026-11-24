import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vault } from "obsidian";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { VaultProjectStore } from "../src/host/vault-store";
import { AnchoredFiles } from "../src/project/anchored-files";
import { PeerpediaApi } from "../src/remote/api";
import { importChanges } from "../src/remote/import";
import { applyMerge, prepareMerge, planMergedFiles, resolveMerge } from "../src/remote/merge";
import type { RemoteBinding, VerifiedSnapshot } from "../src/remote/types";
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
