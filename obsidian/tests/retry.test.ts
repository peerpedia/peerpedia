import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vault } from "obsidian";
import { afterEach, beforeEach, expect, test } from "vitest";
import { VaultProjectStore } from "../src/host/vault-store";
import { prepareSubmission } from "../src/remote/submit";
import { importChanges } from "../src/remote/import";
import type { HttpResponse, Transport } from "../src/remote/types";
import { account, details, origin, project, root, snapshot } from "./fixtures/publishing";
import { readFile, readdir } from "node:fs/promises";
import { vi } from "vitest";
import { AnchoredFiles } from "../src/project/anchored-files";
import { binding, receipt, rehash } from "./fixtures/publishing";
import { SubmissionController } from "../src/remote/controller";
import type { RenderPage as RenderResponsePage, RenderRequest, RenderResponse } from "../renderer/protocol";
import type { PreparedSubmission } from "../src/remote/submit";
import { PeerpediaApi } from "../src/remote/api";
import { applyMerge, planMergedFiles, prepareMerge, resolveMerge } from "../src/remote/merge";
import { verifySnapshot } from "../src/remote/verify";

declare const __PEERPEDIA_ANCHORED__: string;
let vault: string, store: VaultProjectStore;
function reopen(): VaultProjectStore { return new VaultProjectStore(vault,{} as Pick<Vault,"on"|"offref">); }
beforeEach(async (): Promise<void> => {
  vault = await mkdtemp(join(tmpdir(),"peerpedia-submit-"));
  store = reopen();
  await store.create(root,importChanges(snapshot));
});
afterEach(async (): Promise<void> => { await rm(vault,{recursive:true,force:true}); });
function response(status: number, raw: unknown): HttpResponse { return {status,headers:{},body:Buffer.from(JSON.stringify(raw))}; }
test("lost response fences new publishes, reopens the frozen bytes after a local edit and checks actual token owner", async (): Promise<void> => {
  const request = prepareSubmission(project,null,account,"publish",details);
  const posts: [string,string][] = [];
  let user = account.username;
  const transport: Transport = {async request(site: string, route: string, method: string, headers: Readonly<Record<string,string>>, body: Uint8Array|null): Promise<HttpResponse> {
    expect(site).toBe(origin);
    if (route === "/api/v1/me/") return response(200,{...account,expires_at:account.expiresAt,username:user});
    expect(method).toBe("POST");
    posts.push([headers["Idempotency-Key"]!,Buffer.from(body!).toString()]);
    throw new Error("lost");
  }};
  await store.submissions.persistRequest(root,request);
  await expect(store.submissions.sendPrepared(root,request,"token",transport)).rejects.toThrow("lost");
  await writeFile(join(vault,root,"chapters/intro.md"),"later local edit");
  const reopened = reopen();
  await expect(reopened.submissions.persistRequest(root,prepareSubmission(await reopened.read(root),null,account,"publish",details))).rejects.toThrow();
  user = "other";
  await expect(reopened.submissions.retryPending(root,account.username,"different-token",transport)).rejects.toThrow();
  expect(posts).toHaveLength(1);
  user = account.username;
  await expect(reopened.submissions.retryPending(root,user,"replacement-token",transport)).rejects.toThrow("lost");
  expect(posts).toEqual([[request.id,request.payloadJson],[request.id,request.payloadJson]]);
});

function site(push:()=>HttpResponse|Promise<HttpResponse>):Transport {
  return {async request(_origin:string,route:string):Promise<HttpResponse> {
    if (route==="/api/v1/me/") return response(200,{...account,expires_at:account.expiresAt});
    if (route==="/api/v1/categories/") return response(200,{categories:["cs.AI","cs.PL","math.AG"].map((code:string):object=>({code,name:code}))});
    if (route==="/api/v1/licenses/") return response(200,{licenses:[{code:"CC-BY-4.0",label:"CC BY",url:"/license/"}]});
    if (route!=="/api/v1/push/") throw new Error("unexpected route "+route);
    return push();
  }};
}
test.each([401,429,404,500])("HTTP %s keeps the request until manual retry with replacement credentials",async (status:number):Promise<void>=>{
  const request = prepareSubmission(project,null,account,"publish",details);
  let posts = 0;
  const transport = site(():HttpResponse => { ++posts; return posts===1 ? response(status,{error:{code:"not_found"}}) : response(200,receipt(null)); });
  await store.submissions.persistRequest(root,request);
  await expect(store.submissions.sendPrepared(root,request,"temporary-secret",transport)).rejects.toThrow(String(status));
  expect(posts).toBe(1);
  expect(await reopen().submissions.pending(root)).toEqual(request);
  const success = await reopen().submissions.retryPending(root,account.username,"replacement-secret",transport);
  expect((await store.loadBinding(root))?.acceptedBase).toEqual(success);
  expect(posts).toBe(2);
});
test("first definite document rejection releases the slot; a valid but different receipt keeps it pending",async ():Promise<void>=>{
  const request = prepareSubmission(project,null,account,"publish",details);
  await store.submissions.persistRequest(root,request);
  await expect(store.submissions.sendPrepared(root,request,"secret",site(():HttpResponse=>response(400,{error:{code:"invalid_document"}})))).rejects.toThrow();
  expect(await store.submissions.pending(root)).toBeNull();
  const next = prepareSubmission(project,null,account,"publish",details);
  await store.submissions.persistRequest(root,next);
  const wrong = receipt(null); wrong.manifest.title+="different";
  await expect(store.submissions.sendPrepared(root,next,"secret",site(():HttpResponse=>response(201,rehash(wrong))))).rejects.toThrow();
  expect(await store.submissions.pending(root)).toEqual(next);
  expect(await store.loadBinding(root)).toBeNull();
});
test.each(["binding.json","-complete.json"])("crash before %s publication keeps the receipt; reopened recovery performs no second POST",async (suffix:string):Promise<void>=>{
  const request = prepareSubmission(project,null,account,"publish",details);
  await store.submissions.persistRequest(root,request);
  const post = vi.fn(():HttpResponse=>response(201,receipt(null)));
  const rename = AnchoredFiles.prototype.rename;
  const fault = vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this:AnchoredFiles,from:string,to:string,mode:"swap"|"publish"):void {
    if (to.endsWith(suffix)) throw new Error("after receipt");
    rename.call(this,from,to,mode);
  });
  try { await expect(store.submissions.sendPrepared(root,request,"synthetic-bearer",site(post))).rejects.toThrow("after receipt"); }
  finally { fault.mockRestore(); }
  const folder = join(vault,root,".peerpedia-obsidian");
  const bytes = await readFile(join(folder,"submit-"+request.id+"-receipt.json"),"utf8");
  expect(bytes).toContain(receipt(null).hash);
  expect(bytes).not.toContain("synthetic-bearer");
  const resumed = reopen();
  expect(await resumed.submissions.hasReceipt(root,request)).toBe(true);
  const result = await resumed.submissions.recoverReceipt(root,request);
  expect(await resumed.loadBinding(root)).toMatchObject({acceptedBase:result,workingBase:result});
  expect(await resumed.submissions.pending(root)).toBeNull();
  expect(await readdir(folder)).not.toContain("binding-history");
  expect(post).toHaveBeenCalledTimes(1);
});
test("new proposal supersedes the old association without promoting accepted or working bases",async ():Promise<void>=>{
  const old = {...binding,proposalSource:{id:binding.activePr!.id,number:2,snapshot}};
  await store.saveBinding(root,old,null);
  const request = prepareSubmission(project,old,account,"new-pr",details);
  await store.submissions.persistRequest(root,request);
  await expect(store.saveBinding(root,{...old,checkedAt:new Date().toISOString()},(await store.readBindingVersion(root)).digest)).rejects.toThrow();
  const pr = "00000000-0000-0000-0000-0000000000ee";
  const result = await store.submissions.sendPrepared(root,request,"private-bearer",site(():HttpResponse=>response(201,receipt(snapshot.hash,pr))));
  const next = await store.loadBinding(root);
  expect(next).toMatchObject({acceptedBase:snapshot,workingBase:snapshot,lastSubmitted:result,activePr:{id:pr,hash:result.hash,status:"pending"}});
  expect(next?.proposalSource).toBeUndefined();
});
test("formal failure, a stale renderer result, changed local revision, and a divergent native pane stop confirmation",async ():Promise<void>=>{
  const post = vi.fn(():HttpResponse=>response(201,receipt(null)));
  const render = vi.fn(async (req:RenderRequest):Promise<RenderResponse>=>({id:req.id,revision:req.revision,pages:req.document.chapters.map((ch:RenderRequest["document"]["chapters"][number]):RenderResponsePage => ({id:ch.id,title:ch.title,html:"<p>test</p>",targets:[]}))}));
  const controller = new SubmissionController(store,():{origin:string;username:string}=>({origin,username:account.username}),
    {read:async ():Promise<string>=>"new-bearer",write:vi.fn(),remove:vi.fn()},site(post),render);
  const signal = new AbortController().signal;
  render.mockImplementationOnce(async (req:RenderRequest):Promise<RenderResponse>=>({id:req.id,revision:req.revision,error:{message:"invalid formula"}}));
  await expect(controller.review(root,"publish",details,signal)).rejects.toThrow("invalid formula");
  render.mockImplementationOnce(async (req:RenderRequest):Promise<RenderResponse>=>({id:req.id,revision:"previous",pages:[]}));
  await expect(controller.review(root,"publish",details,signal)).rejects.toThrow(/revision/);
  const preview = await controller.review(root,"publish",details,signal);
  const draft = new VaultProjectStore(vault,{} as Pick<Vault,"on"|"offref">,{buffers:(path:string):readonly string[]=>path.endsWith("intro.md")?["live unsaved"]:[]});
  await expect(draft.submissions.persistRequest(root,preview.request)).rejects.toThrow();
  await writeFile(join(vault,root,"chapters/intro.md"),"edit after preview");
  await expect(controller.confirm(preview,():boolean=>true)).rejects.toThrow(/changed/);
  expect(await store.submissions.pending(root)).toBeNull();
  expect(post).not.toHaveBeenCalled();
});
test("transport runs outside the filesystem lock and two delayed same-ID attempts cannot release a competing new submission",async ():Promise<void>=>{
  let started!:()=>void, release!:()=>void;
  const start = new Promise<void>((resolve:()=>void):void=>{ started=resolve; });
  const waiting = new Promise<void>((resolve:()=>void):void=>{ release=resolve; });
  const request:PreparedSubmission = prepareSubmission(project,null,account,"publish",details);
  await store.submissions.persistRequest(root,request);
  const original = store.submissions.sendPrepared(root,request,"old-bearer",site(async ():Promise<HttpResponse>=>{
    started(); await waiting; return response(201,receipt(null));
  }));
  await start;
  try {
    const child = await promisify(execFile)(process.execPath,["--import","tsx",
      fileURLToPath(new URL("./fixtures/submission-contender.ts",import.meta.url)),vault],
      {env:{...process.env,PEERPEDIA_TEST_ANCHORED:__PEERPEDIA_ANCHORED__}});
    expect(child.stdout).toContain("awaiting confirmation");
    const competitor = reopen();
    expect(await competitor.submissions.pending(root)).toEqual(request);
    await expect(competitor.submissions.persistRequest(root,prepareSubmission(project,null,account,"publish",details))).rejects.toThrow(/awaiting/);
    await expect(competitor.submissions.retryPending(root,account.username,"new-bearer",site(():HttpResponse=>response(409,{error:{code:"stale_base"}})))).rejects.toThrow();
    expect(await competitor.submissions.pending(root)).toEqual(request);
  } finally { release(); }
  expect((await original).hash).toBe(receipt(null).hash);
  expect(await store.submissions.pending(root)).toBeNull();
});

test("a later accepted proposal migrates only on confirmed merge and keeps edits after submission",async ():Promise<void>=>{
  await store.saveBinding(root,binding,null);
  const request = prepareSubmission(project,binding,account,"append-pr",details);
  await store.submissions.persistRequest(root,request);
  const raw = receipt(snapshot.hash,binding.activePr!.id,2);
  const pending = await store.submissions.sendPrepared(root,request,"local-bearer",site(():HttpResponse=>response(201,raw)));
  expect((await store.loadBinding(root))?.acceptedBase.hash).toBe(snapshot.hash);
  const path = join(vault,root,"chapters/intro.md");
  const newer = await readFile(path,"utf8")+"\nUnsubmitted edit";
  await writeFile(path,newer);
  const accepted = verifySnapshot({...raw,status:"accepted"});
  const api = new PeerpediaApi(origin,{request:vi.fn()});
  vi.spyOn(api,"current").mockResolvedValue(accepted);
  vi.spyOn(api,"prs").mockResolvedValue([{...binding.activePr!,status:"accepted",submissionId:accepted.submissionId,hash:accepted.hash}]);
  const edited = await store.read(root);
  const comparison = await prepareMerge(edited,"accepted",store,api);
  expect(comparison.base).toEqual(pending);
  const changes = planMergedFiles(edited,resolveMerge(comparison.result,{}));
  await applyMerge(edited,changes,comparison.check,store,api);
  expect(await readFile(path,"utf8")).toBe(newer);
  expect(await store.loadBinding(root)).toMatchObject({acceptedBase:accepted,workingBase:accepted,lastSubmitted:pending});
});
test("journal tampering is detected before contacting any site",async ():Promise<void>=>{
  const request = prepareSubmission(project,null,account,"publish",details);
  await store.submissions.persistRequest(root,request);
  const path = join(vault,root,".peerpedia-obsidian/submit-pending.json");
  const row: {request:PreparedSubmission} = JSON.parse(await readFile(path,"utf8"));
  row.request.origin = "https://wrong.invalid";
  await writeFile(path,JSON.stringify(row));
  const contact = vi.fn();
  await expect(reopen().submissions.retryPending(root,account.username,"private-bearer",{request:contact})).rejects.toThrow();
  expect(contact).not.toHaveBeenCalled();
});

test("a documented credential rejection followed by a definite stale response releases the request",async ():Promise<void>=>{
  await store.saveBinding(root,binding,null);
  const request = prepareSubmission(project,binding,account,"new-pr",details);
  await store.submissions.persistRequest(root,request);
  await expect(store.submissions.sendPrepared(root,request,"expired-secret",site(():HttpResponse=>response(401,{error:{code:"invalid_token"}})))).rejects.toThrow();
  await expect(store.submissions.retryPending(root,account.username,"replacement-secret",site(():HttpResponse=>response(409,{error:{code:"stale_base"}})))).rejects.toThrow();
  expect(await store.submissions.pending(root)).toBeNull();
});
