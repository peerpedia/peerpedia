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
import type { HttpResponse, Transport, VerifiedSnapshot } from "../src/remote/types";
import { account, details, origin, project, root, snapshot } from "./fixtures/publishing";
import { readFile, readdir } from "node:fs/promises";
import { vi } from "vitest";
import { AnchoredFiles } from "../src/project/anchored-files";
import original from "./fixtures/manifests/v4.json";
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
    if (route==="/api/v1/submissions/"+snapshot.submissionId+"/") return response(200,{...original,status:"pending",pull_request:{id:binding.activePr!.id,snapshot:1}});
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

test.each(["proposal","status","httpStatus","licenseLabel"])("offline recovery refuses a corrupted %s after a verified new proposal receipt",async (field:string):Promise<void>=>{
  await store.saveBinding(root,binding,null);
  const request = prepareSubmission(project,binding,account,"new-pr",details);
  await store.submissions.persistRequest(root,request);
  const prId = "00000000-0000-0000-0000-0000000000ee";
  const raw = receipt(snapshot.hash,prId);
  const rename = AnchoredFiles.prototype.rename;
  const fault = vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this:AnchoredFiles,from:string,to:string,mode:"swap"|"publish"):void {
    if (to.endsWith("binding-history/1.json")) throw new Error("before binding");
    rename.call(this,from,to,mode);
  });
  try { await expect(store.submissions.sendPrepared(root,request,"test-only-token",site(():HttpResponse=>response(201,raw)))).rejects.toThrow("before binding"); }
  finally { fault.mockRestore(); }
  const path = join(vault,root,".peerpedia-obsidian/submit-"+request.id+"-receipt.json");
  const saved = JSON.parse(await readFile(path,"utf8"));
  if (field==="proposal") saved.raw.pull_request.id = "00000000-0000-0000-0000-0000000000ef";
  else if (field==="status") saved.raw.status = "withdrawn";
  else if (field==="licenseLabel") saved.raw.licensing.label="changed";
  else saved.httpStatus=200;
  await writeFile(path,JSON.stringify(saved));
  await expect(reopen().submissions.recoverReceipt(root,request)).rejects.toThrow();
  expect(await reopen().loadBinding(root)).toEqual(binding);
  expect(await reopen().submissions.pending(root)).toEqual(request);
});

test("direct append freezes exact predecessor before POST and rejects impossible superseded ordinal on restarted replay",async ():Promise<void>=>{
  await store.saveBinding(root,binding,null);
  const req = prepareSubmission(project,binding,account,"append-pr",details), previous = binding.activePr!;
  const exact = vi.spyOn(PeerpediaApi.prototype,"proposalSnapshot").mockResolvedValue({snapshot:{...snapshot,status:"pending"},proposal:{id:previous.id,number:6}});
  const first = site(():HttpResponse=>{throw new Error("lost response");});
  try {
    await store.submissions.persistRequest(root,req);
    await expect(store.submissions.sendPrepared(root,req,"test-token",first)).rejects.toThrow("lost response");
    expect(exact).toHaveBeenCalledExactlyOnceWith(previous.submissionId);
    exact.mockRejectedValue(new Error("original frozen proof must be used"));
    const bad = {...receipt(snapshot.hash,previous.id,999),status:"superseded"};
    await expect(reopen().submissions.retryPending(root,account.username,"test-token",site(():HttpResponse=>response(200,bad)))).rejects.toThrow();
    expect(await reopen().submissions.pending(root)).toEqual(req);
    const good = {...bad,pull_request:{id:previous.id,snapshot:7}};
    await reopen().submissions.retryPending(root,account.username,"test-token",site(():HttpResponse=>response(200,good)));
    expect((await store.loadBinding(root))?.proposalSource?.number).toBe(7);
    expect(exact).toHaveBeenCalledTimes(1);
  } finally {exact.mockRestore();}
});

test("a changed unrelated head prevents append but allows independent new-proposal review and confirmation",async ():Promise<void>=>{
  await store.saveBinding(root,binding,null);
  const head = binding.activePr!, newId = "00000000-0000-0000-0000-0000000000ee";
  const current = vi.spyOn(PeerpediaApi.prototype,"current").mockResolvedValue(snapshot);
  const prs = vi.spyOn(PeerpediaApi.prototype,"prs").mockResolvedValue([{...head,hash:"a".repeat(64)}]);
  const controller = new SubmissionController(store,():{origin:string;username:string}=>({origin,username:account.username}),
    {read:async ():Promise<string>=>"site-token",write:vi.fn(),remove:vi.fn()},site(():HttpResponse=>response(201,receipt(snapshot.hash,newId))),
    async (req:RenderRequest):Promise<RenderResponse>=>({id:req.id,revision:req.revision,pages:req.document.chapters.map(
      (ch:RenderRequest["document"]["chapters"][number]):RenderResponsePage=>({id:ch.id,title:ch.title,html:"text",targets:[]}))}));
  try {
    expect((await controller.open(root)).intent).toBe("new-pr");
    await expect(controller.review(root,"append-pr",details,new AbortController().signal)).rejects.toThrow();
    const review = await controller.review(root,"new-pr",details,new AbortController().signal);
    expect(JSON.parse(review.request.payloadJson)).not.toHaveProperty("pull_request_id");
    prs.mockResolvedValue([{...head,hash:"b".repeat(64)}]);
    await controller.confirm(review,():boolean=>true);
    expect((await store.loadBinding(root))?.activePr?.id).toBe(newId);
  } finally {current.mockRestore(); prs.mockRestore();}
});

test("controller freezes the ordinal compared at confirmation and a restart keeps that exact predecessor",async ():Promise<void>=>{
  await store.saveBinding(root,binding,null);
  const head = binding.activePr!;
  const current = vi.spyOn(PeerpediaApi.prototype,"current").mockResolvedValue(snapshot);
  const prs = vi.spyOn(PeerpediaApi.prototype,"prs").mockResolvedValue([head]);
  const exact = vi.spyOn(PeerpediaApi.prototype,"proposalSnapshot").mockResolvedValue({snapshot:{...snapshot,status:"pending"},proposal:{id:head.id,number:6}});
  const post = vi.fn(():HttpResponse=>response(201,receipt(snapshot.hash,head.id,999)));
  const controller = new SubmissionController(store,():{origin:string;username:string}=>({origin,username:account.username}),
    {read:async ():Promise<string>=>"site-token",write:vi.fn(),remove:vi.fn()},site(post),async (req:RenderRequest):Promise<RenderResponse>=>({
      id:req.id,revision:req.revision,pages:req.document.chapters.map((ch:RenderRequest["document"]["chapters"][number]):RenderResponsePage=>
        ({id:ch.id,title:ch.title,html:"<p>test</p>",targets:[]}))}));
  try {
    const review = await controller.review(root,"append-pr",details,new AbortController().signal);
    exact.mockResolvedValueOnce({snapshot:{...snapshot,status:"pending"},proposal:{id:head.id,number:7}});
    await expect(controller.confirm(review,():boolean=>true)).rejects.toThrow(/changed/);
    expect(post).not.toHaveBeenCalled();
    await expect(controller.confirm(review,():boolean=>true)).rejects.toThrow();
    expect(post).toHaveBeenCalledTimes(1);
    expect(exact).toHaveBeenCalledTimes(3);
    const pending = JSON.parse(await readFile(join(vault,root,".peerpedia-obsidian/submit-pending.json"),"utf8"));
    expect(pending.head).toEqual({id:head.id,hash:head.hash,submissionId:head.submissionId,number:6});
    expect(await reopen().submissions.pending(root)).toEqual(review.request);
    post.mockReturnValue(response(200,receipt(snapshot.hash,head.id,7)));
    await reopen().submissions.retryPending(root,account.username,"site-token",site(post));
    expect(exact).toHaveBeenCalledTimes(3);
  } finally {current.mockRestore();prs.mockRestore();exact.mockRestore();}
});

test("old unsigned receipt can only complete after an explicit verified same-key replay",async ():Promise<void>=>{
  const request = prepareSubmission(project,null,account,"publish",details);
  await store.submissions.persistRequest(root,request);
  const path = join(vault,root,".peerpedia-obsidian/submit-"+request.id+"-receipt.json");
  await writeFile(path,JSON.stringify({id:request.id,payloadDigest:request.payloadDigest,checkedAt:new Date().toISOString(),raw:receipt(null)}));
  await expect(reopen().submissions.recoverReceipt(root,request)).rejects.toThrow();
  const post = vi.fn(():HttpResponse=>response(200,receipt(null)));
  await reopen().submissions.retryPending(root,account.username,"site-token",site(post));
  expect(post).toHaveBeenCalledTimes(1);
  const saved = JSON.parse(await readFile(path,"utf8"));
  expect(saved.httpStatus).toBe(200);
  expect(saved.digest).toMatch(/^[0-9a-f]{64}$/);
});
test("a verified saved receipt finishes offline even after later paper.json becomes unreadable",async ():Promise<void>=>{
  const req = prepareSubmission(project,null,account,"publish",details);
  await store.submissions.persistRequest(root,req);
  const rename = AnchoredFiles.prototype.rename;
  const fault = vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this:AnchoredFiles,from:string,to:string,mode:"swap"|"publish"):void {
    if (to.endsWith("/binding.json")) throw new Error("before binding");
    rename.call(this,from,to,mode);
  });
  try { await expect(store.submissions.sendPrepared(root,req,"local-secret",site(():HttpResponse=>response(201,receipt(null))))).rejects.toThrow("before binding"); }
  finally { fault.mockRestore(); }
  const config = join(vault,root,"paper.json"), damaged = Buffer.from([255]);
  await writeFile(config,damaged);
  const reopened = reopen();
  await expect(reopened.read(root)).rejects.toThrow();
  await reopened.submissions.recoverReceipt(root,req);
  expect(await reopened.submissions.pending(root)).toBeNull();
  expect(await readFile(config)).toEqual(damaged);
});

test.each([
  ["before binding","damaged JSON","pending"],["before binding","damaged checksum","pending"],["before binding","damaged bytes","pending"],
  ["after binding","damaged checksum","accepted"],["after binding","damaged JSON","superseded"],
  ["after binding","legacy","accepted"],["after binding","legacy","superseded"],
])("manual replay repairs %s / %s / %s with original bytes and preserves the committed binding",async (boundary:string,damage:string,status:string):Promise<void>=>{
  await store.saveBinding(root,binding,null);
  const request = prepareSubmission(project,binding,account,"new-pr",details);
  await store.submissions.persistRequest(root,request);
  const id = "00000000-0000-0000-0000-0000000000ee";
  const raw = receipt(snapshot.hash,id);
  const attempts:[string,string][] = [];
  const service = (answer:HttpResponse):Transport => ({
    async request(originValue:string,route:string,method:"GET"|"POST",headers:Readonly<Record<string,string>>,body:Uint8Array|null):Promise<HttpResponse> {
      if (method === "GET") return site(():HttpResponse=>{throw new Error("unexpected GET");}).request(originValue,route,method,headers,body);
      attempts.push([headers["Idempotency-Key"],Buffer.from(body!).toString()]);
      return answer;
    },
  });
  const rename = AnchoredFiles.prototype.rename;
  const fault = vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this:AnchoredFiles,from:string,to:string,mode:"swap"|"publish"):void {
    if (to.endsWith(boundary==="after binding" ? "-complete.json" : "/binding-history/1.json")) throw new Error("simulated crash");
    rename.call(this,from,to,mode);
  });
  try { await expect(store.submissions.sendPrepared(root,request,"test-token",service(response(201,raw)))).rejects.toThrow("simulated crash"); }
  finally { fault.mockRestore(); }
  const dir = join(vault,root,".peerpedia-obsidian"), path = join(dir,"submit-"+request.id+"-receipt.json");
  const written = JSON.parse(await readFile(path,"utf8"));
  if (damage==="legacy") { delete written.digest; delete written.httpStatus; }
  else written.raw.licensing.label = "damaged field";
  const damaged = damage==="damaged bytes" ? Buffer.from([255]) : Buffer.from(damage==="damaged JSON" ? "{truncated receipt" : JSON.stringify(written));
  await writeFile(path,damaged);
  const reopened = reopen(), before = await reopened.readBindingVersion(root);
  await expect(reopened.submissions.recoverReceipt(root,request)).rejects.toThrow();
  expect(await reopened.submissions.hasReceipt(root,request)).toBe(false);
  await expect(reopened.submissions.persistRequest(root,prepareSubmission(project,binding,account,"new-pr",details))).rejects.toThrow(/awaiting/);
  await expect(reopened.submissions.retryPending(root,"different","wrong-token",service(response(200,raw)))).rejects.toThrow();
  expect(attempts).toHaveLength(1);
  // A stale rejection, an unrelated snapshot, or a different proposal cannot complete this repair.
  await expect(reopened.submissions.retryPending(root,account.username,"test-token",service(response(409,{error:{code:"stale_pr"}})))).rejects.toThrow();
  await expect(reopened.submissions.retryPending(root,account.username,"test-token",service(response(201,raw)))).rejects.toThrow();
  const wrong = {...raw,ai_assisted:true};
  await expect(reopened.submissions.retryPending(root,account.username,"test-token",service(response(200,wrong)))).rejects.toThrow();
  if (boundary==="after binding") {
    const differentSnapshot = structuredClone(raw);
    differentSnapshot.manifest.submission_id = snapshot.submissionId;
    await expect(reopened.submissions.retryPending(root,account.username,"test-token",service(response(200,rehash(differentSnapshot))))).rejects.toThrow();
    const other = {...raw,pull_request:{id:snapshot.paperId,snapshot:1},status};
    await expect(reopened.submissions.retryPending(root,account.username,"test-token",service(response(200,other)))).rejects.toThrow();
  }
  if (boundary==="after binding" && damage==="legacy" && status==="accepted") {
    const tipPath = join(dir,"binding-history","1.json");
    const originalTip = await readFile(tipPath);
    const altered = JSON.parse(originalTip.toString());
    altered.binding.workingBase = verifySnapshot({...raw,status:"accepted"});
    await writeFile(tipPath,JSON.stringify(altered));
    try {
      await expect(reopened.submissions.retryPending(root,account.username,"test-token",service(response(200,{...raw,status})))).rejects.toThrow(/binding changed/);
    } finally {await writeFile(tipPath,originalTip);}
  }
  expect(await readFile(path)).toEqual(damaged);
  expect(await reopened.readBindingVersion(root)).toEqual(before);
  const retry = ():Promise<VerifiedSnapshot>=>reopened.submissions.retryPending(root,account.username,"replacement-token",service(response(200,{...raw,status})));
  let result:VerifiedSnapshot;
  if (boundary==="after binding" && damage==="legacy" && status==="accepted") {
    const stop = vi.spyOn(AnchoredFiles.prototype,"rename").mockImplementation(function(this:AnchoredFiles,from:string,to:string,mode:"swap"|"publish"):void {
      if (to.endsWith("-complete.json")) throw new Error("after receipt replacement");
      rename.call(this,from,to,mode);
    });
    try { await expect(retry()).rejects.toThrow("after receipt replacement"); } finally { stop.mockRestore(); }
    const count = attempts.length;
    result = await reopen().submissions.recoverReceipt(root,request);
    expect(attempts).toHaveLength(count);
  } else result = await retry();
  expect(result.hash).toBe(raw.hash);
  expect(result.status).toBe(status);
  expect(await reopened.submissions.pending(root)).toBeNull();
  const after = await reopened.readBindingVersion(root);
  expect(after.binding).toMatchObject({acceptedBase:snapshot,workingBase:snapshot,activePr:{id,status:"pending"},lastSubmitted:{hash:raw.hash,status:"pending"}});
  if (boundary==="after binding") {
    expect(after.digest).toBe(before.digest);
    expect(after.binding).toEqual(before.binding);
  }
  for (const attempt of attempts) expect(attempt).toEqual([request.id,request.payloadJson]);
  expect(JSON.parse(await readFile(path,"utf8"))).toMatchObject({id:request.id,payloadDigest:request.payloadDigest,httpStatus:200,raw:{status}});
  const evidence = (await readdir(dir)).filter((name:string):boolean=>name.startsWith("submit-"+request.id+"-receipt.json.replaced-"));
  expect(evidence).toHaveLength(1);
  expect(await readFile(join(dir,evidence[0]))).toEqual(damaged);
});
