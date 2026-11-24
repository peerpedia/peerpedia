import { expect, test } from "vitest";
import { prepareSubmission, defaultIntent } from "../src/remote/submit";
import { project, binding, account, origin, details } from "./fixtures/publishing";
import { rehash, receipt, type Receipt } from "./fixtures/publishing";
import { verifyReceipt } from "../src/remote/submit";
import { sourceDigest } from "../src/project/store";
import { type ProjectSnapshot } from "../src/project/types";

test("freezes initial origin and null base; only an owned open proposal defaults to append", (): void => {
  const request = prepareSubmission(project,null,account,"publish",details);
  expect(request.origin).toBe(origin);
  expect(JSON.parse(request.payloadJson)).toMatchObject({paper_id:null,base_hash:null,ai_assisted:false,chapters:binding.workingBase.document.chapters});
  expect((): unknown => prepareSubmission(project,null,account,"publish",details,"https://wrong.invalid")).toThrow();
  expect(defaultIntent(binding,account.username)).toBe("append-pr");
  expect(defaultIntent(binding,"other")).toBe("new-pr");
  expect(defaultIntent({...binding,activePr:{...binding.activePr!,status:"withdrawn"}},account.username)).toBe("new-pr");
  expect(JSON.parse(prepareSubmission(project,binding,account,"append-pr",details).payloadJson)).toMatchObject({
    paper_id:binding.paperId,base_hash:binding.acceptedBase.hash,pull_request_id:binding.activePr!.id,expected_head:binding.activePr!.hash});
  expect(JSON.parse(prepareSubmission(project,binding,account,"new-pr",details).payloadJson)).not.toHaveProperty("expected_head");
});

test("selected loopback and site agreement, token scopes, metadata normalization", ():void => {
  const loopback = "http://127.0.0.1:9181";
  const remote = {...account,agreement:{...account.agreement,url:loopback+"/terms"}};
  const draft:ProjectSnapshot = {...project,config:{...project.config,title:"   actual title "}};
  const request = prepareSubmission(draft,null,remote,"publish",{...details,explanation:"  "},loopback);
  expect(request.origin).toBe(loopback);
  expect(JSON.parse(request.payloadJson)).toMatchObject({title:"actual title",explanation:"Initial publication."});
  expect((): unknown => prepareSubmission(project,null,{...remote,scopes:["propose"]},"publish",details)).toThrow(/scope/);
  expect((): unknown => prepareSubmission(project,null,{...remote,agreement:{...remote.agreement,accepted:false}},"publish",details)).toThrow(/website/);
});
test("self-consistent snapshots with different submitted content, identity, AI flag or proposal are refused", ():void => {
  const request = prepareSubmission(project,binding,account,"append-pr",details);
  const valid = receipt(binding.acceptedBase.hash,binding.activePr!.id,2);
  const head = {...binding.activePr!,number:1};
  expect(verifyReceipt(request,valid,head).snapshot.hash).toBe(valid.hash);
  const mutations:((row:Receipt)=>void)[] = [
    (row:Receipt):void => { row.manifest.title+="!"; },(row:Receipt):void => { row.manifest.authors+="!"; },
    (row:Receipt):void => { row.manifest.abstract+="!"; },(row:Receipt):void => { row.manifest.explanation+="!"; },
    (row:Receipt):void => { row.manifest.primary_category="cs.CL"; },(row:Receipt):void => { row.manifest.secondary_categories=[]; },
    (row:Receipt):void => { row.manifest.license="different"; },(row:Receipt):void => { row.manifest.paper_id=row.manifest.submission_id; },
    (row:Receipt):void => { row.manifest.base_hash=null; },(row:Receipt):void => { row.manifest.contributor_name="other"; },
    (row:Receipt):void => { row.pull_request!.id=row.manifest.paper_id; },(row:Receipt):void => { row.pull_request!.snapshot=1; },
    (row:Receipt):void => { row.ai_assisted=true; },(row:Receipt):void => {
      row.bibliography+="!"; row.manifest.bibliography_sha256=sourceDigest(Buffer.from(row.bibliography)); },
    (row:Receipt):void => {
      row.chapters.reverse(); row.manifest.chapters.reverse(); row.markdown=row.chapters.map((c:Receipt["chapters"][number]):string=>c.markdown).join("\n\n");
      row.manifest.markdown_sha256=sourceDigest(Buffer.from(row.markdown)); },
  ];
  for (const mutate of mutations) {
    const row = structuredClone(valid);
    mutate(row);
    expect(():unknown => verifyReceipt(request,rehash(row),head)).toThrow();
  }
});

test("append receipts must be the exact successor of the reviewed ordinal", ():void => {
  const request = prepareSubmission(project,binding,account,"append-pr",details);
  const head = {...binding.activePr!,number:7};
  expect(verifyReceipt(request,receipt(binding.acceptedBase.hash,head.id,8),head).proposal?.number).toBe(8);
  expect(():unknown=>verifyReceipt(request,receipt(binding.acceptedBase.hash,head.id,999),head)).toThrow();
});

test("fresh submissions name required local metadata and a blank proposal explanation", (): void => {
  for (const [field,label] of [["title","title"],["authors","authors"],["abstract","abstract"],["primary_category","primary subject"],["license","license"]]) {
    const draft = {...project,config:{...project.config,[field]:""}};
    expect((): unknown => prepareSubmission(draft,null,account,"publish",details)).toThrow(new RegExp(label,"i"));
  }
  expect((): unknown => prepareSubmission(project,binding,account,"new-pr",{...details,explanation:"  "})).toThrow(/explanation/i);
});
