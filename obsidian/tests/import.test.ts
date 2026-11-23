import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vault } from "obsidian";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { VaultProjectStore } from "../src/host/vault-store";
import { AnchoredFiles } from "../src/project/anchored-files";
import { PeerpediaApi } from "../src/remote/api";
import { checkProject, checkRemote } from "../src/remote/controller";
import { importPaper } from "../src/remote/import";
import type { HttpResponse, RemoteBinding, RemoteTarget } from "../src/remote/types";
import old from "./fixtures/manifests/v1.json";
import earlier from "./fixtures/manifests/v3.json";
import current from "./fixtures/manifests/v4.json";

let vault: string;
let store: VaultProjectStore;
const origin = "https://fixture.invalid";
const qualifier = old.paper_identifier;
const paper = old.manifest.paper_id;
const target: RemoteTarget = {kind:"snapshot", identifier:old.manifest.submission_id, expectedPaperIdentifier:qualifier};
const calls: string[] = [];
function api(status: number = 200, head: typeof current | typeof earlier = current): PeerpediaApi {
  return new PeerpediaApi(origin, {request: async (_origin: string, path: string): Promise<HttpResponse> => {
    calls.push(path);
    let body: unknown;
    if (path === "/api/v1/submissions/" + old.manifest.submission_id + "/") body = old;
    else if ([qualifier, paper].some((id: string): boolean => path === "/api/v1/papers/" + id + "/")) {
      body = {paper_id:paper,paper_identifier:qualifier,current:head};
    } else if (path === "/api/v1/papers/" + paper + "/prs/") body = {paper_id:paper,prs:[],next:null};
    else throw new Error("unexpected route");
    return {status, headers:{}, body:Buffer.from(JSON.stringify(body))};
  }});
}
beforeEach(async (): Promise<void> => {
  vault = await mkdtemp(join(tmpdir(),"peerpedia-import-"));
  store = new VaultProjectStore(vault, {} as Pick<Vault,"on"|"offref">);
  calls.length = 0;
});
afterEach(async (): Promise<void> => { vi.restoreAllMocks(); await rm(vault,{recursive:true,force:true}); });

test("version-qualified import keeps the exact historical source and records the verified current paper separately", async (): Promise<void> => {
  await importPaper(target,"historical",api(),store);
  expect(await readFile(join(vault,"historical/paper.md"),"utf8")).toBe(old.markdown);
  expect(await store.loadBinding("historical")).toMatchObject({origin,paperId:paper,
    workingBase:{hash:old.hash},acceptedBase:{hash:current.hash},activePr:null,lastSubmitted:null});
  expect(calls).toEqual(["/api/v1/submissions/" + old.manifest.submission_id + "/", "/api/v1/papers/" + qualifier + "/"]);
});
test("chaptered import writes the declared order, exact source bytes and bibliography", async (): Promise<void> => {
  const result = await importPaper({kind:"paper",identifier:paper},"chaptered",api(),store);
  expect(result.config.chapters?.map((ch: {id:string}): string => ch.id)).toEqual(["intro","results"]);
  for (const [i,ch] of result.config.chapters!.entries()) {
    expect(await readFile(join(vault,"chaptered",ch.file),"utf8")).toBe(current.chapters[i].markdown);
  }
  expect(await readFile(join(vault,"chaptered",result.config.bibliography!),"utf8")).toBe(current.bibliography);
  expect(calls).toEqual(["/api/v1/papers/" + paper + "/"]);
});
test("refuses every existing target including an empty directory", async (): Promise<void> => {
  await mkdir(join(vault,"occupied"));
  await expect(importPaper(target,"occupied",api(),store)).rejects.toThrow(/已存在/);
  expect(await readdir(join(vault,"occupied"))).toEqual([]);
});
test("a valid snapshot qualified by a different paper fails before any vault write", async (): Promise<void> => {
  const other = structuredClone(old);
  other.manifest.paper_id = "00000000-0000-0000-0000-000000000002";
  // V1's flat manifest has only scalar fields, so this is Python sorted-key serialization.
  other.hash = createHash("sha256").update(JSON.stringify(other.manifest,Object.keys(other.manifest).sort())).digest("hex");
  other.snapshot_identifier = "240229." + other.hash.slice(0,12);
  const client = new PeerpediaApi(origin,{request:async (_origin: string, route: string): Promise<HttpResponse> => {
    calls.push(route);
    const body = route.startsWith("/api/v1/submissions/") ? old : {paper_id:other.manifest.paper_id,paper_identifier:qualifier,current:other};
    return {status:200,headers:{},body:Buffer.from(JSON.stringify(body))};
  }});
  await expect(importPaper(target,"mismatch",client,store)).rejects.toThrow(/论文与快照不一致/);
  expect(calls).toEqual(["/api/v1/submissions/" + old.manifest.submission_id + "/", "/api/v1/papers/" + qualifier + "/"]);
  expect(await readdir(vault)).toEqual([]);
});
test("unsafe chapter ids fail before a directory or projected chapter is created", async (): Promise<void> => {
  const client = api();
  const bad = await client.current(paper);
  bad.document.chapters = [{id:"../../escape",title:"bad",markdown:"bad"}];
  vi.spyOn(client,"current").mockResolvedValue(bad);
  await expect(importPaper({kind:"paper",identifier:paper},"nested",client,store)).rejects.toThrow(/章节|chapter/);
  expect(await readdir(vault)).toEqual([]);
});
test("closing the form while the current response is pending cancels before commit", async (): Promise<void> => {
  const client = api();
  const head = await client.current(paper);
  let live = true;
  vi.spyOn(client,"current").mockImplementation(async (): Promise<typeof head> => { live = false; return head; });
  await expect(importPaper(target,"cancelled",client,store,():boolean => live)).rejects.toThrow(/取消|更改/);
  expect(await readdir(vault)).toEqual([]);
});
test("an interrupted binding commit is reported and recoverable after restart without another request", async (): Promise<void> => {
  const rename = AnchoredFiles.prototype.rename;
  vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this:AnchoredFiles,from:string,to:string,op:"publish"|"swap"):void {
    if (to.endsWith("/binding.json")) throw new Error("disk interrupted");
    rename.call(this,from,to,op);
  });
  await expect(importPaper(target,"partial",api(),store)).rejects.toThrow();
  expect(await readFile(join(vault,"partial/paper.md"),"utf8")).toBe(old.markdown);
  vi.restoreAllMocks();
  const reopened = new VaultProjectStore(vault, {} as Pick<Vault,"on"|"offref">);
  expect(await reopened.readBindingVersion("partial")).toMatchObject({pendingImport:true,binding:null});
  await writeFile(join(vault,"partial/paper.md"),"post-interruption local work");
  await expect(reopened.recoverImport("partial")).rejects.toThrow(/已更改/);
  expect(await readFile(join(vault,"partial/paper.md"),"utf8")).toBe("post-interruption local work");
  await writeFile(join(vault,"partial/paper.md"),old.markdown);
  await reopened.recoverImport("partial");
  expect(await reopened.loadBinding("partial")).toMatchObject({workingBase:{hash:old.hash},acceptedBase:{hash:current.hash}});
  expect(calls).toHaveLength(2);
});
test("an explicit check preserves local edits and working base, and a subsequent hidden/401 failure preserves binding bytes", async (): Promise<void> => {
  await importPaper(target,"edit",api(200,earlier),store);
  await writeFile(join(vault,"edit/paper.md"),"local changes");
  const check = await checkProject("edit",api(),store);
  expect(check.current.hash).toBe(current.hash);
  const before = await store.readBindingVersion("edit");
  expect(before.binding).toMatchObject({workingBase:{hash:old.hash},acceptedBase:{hash:earlier.hash}});
  for (const status of [404,401,503]) await expect(checkProject("edit",api(status),store)).rejects.toThrow(String(status));
  expect(await store.readBindingVersion("edit")).toEqual(before);
  expect(await readFile(join(vault,"edit/paper.md"),"utf8")).toBe("local changes");
});

test("a missing bound proposal or a mismatched site leaves the project's binding intact", async (): Promise<void> => {
  const project = await importPaper(target,"proposal",api(),store);
  const {binding,digest} = await store.readBindingVersion(project.root);
  const withPr: RemoteBinding = {...binding!,activePr:{id:"00000000-0000-0000-0000-000000000099",hash:old.hash,
    submissionId:old.manifest.submission_id,owner:"synthetic",status:"pending"}};
  await store.saveBinding(project.root,withPr,digest);
  const before = await store.readBindingVersion(project.root);
  await expect(checkProject(project.root,api(),store)).rejects.toThrow(/提案当前不可见/);
  expect(await store.readBindingVersion(project.root)).toEqual(before);
  const lastCall = calls.length;
  await expect(checkRemote({...withPr,origin:"https://another.invalid"},api())).rejects.toThrow(/站点/);
  expect(calls).toHaveLength(lastCall);
});
