import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import type { AnchoredFiles } from "../project/anchored-files";
import type { ProjectSnapshot } from "../project/types";
import { decodeJson, HttpStatusError, PeerpediaApi } from "./api";
import { sourceDigest } from "../project/store";
import { isBindingSuccessor, readVersion, writeVersion } from "./binding";
import { checkAccount, decodeRequest, frozenPayload, publication, verifyReceipt, type PreparedSubmission, type PushReceipt } from "./submit";
import type { RemoteBinding, Transport, VerifiedSnapshot } from "./types";
import { checksum, object, ProtocolError } from "./verify";

const state = ".peerpedia-obsidian";
export const pendingPush = "submit-pending.json";
type Storage = <T>(root:string, operation:(tree:AnchoredFiles, readCurrent:()=>Promise<ProjectSnapshot>)=>Promise<T>)=>Promise<T>;
interface Pending {request:PreparedSubmission; previous:string|null}
interface SavedReceipt {id:string; payloadDigest:string; checkedAt:string; raw:unknown}

async function put(tree: AnchoredFiles, root: string, name: string, data: unknown): Promise<void> {
  const dir = join(root,state);
  const stage = join(dir,".submit-" + randomUUID());
  await tree.file(stage,JSON.stringify(data));
  tree.rename(stage,join(dir,name),"publish");
  await tree.sync(dir);
}

async function readPending(tree: AnchoredFiles, root: string): Promise<Pending|null> {
  const file = await tree.source(join(root,state,pendingPush));
  if (!file) return null;
  const row = object(JSON.parse(file.text));
  const pending = {request:decodeRequest(row.request),previous:row.previous === null ? null : checksum(row.previous)};
  if (row.digest !== sourceDigest(Buffer.from(JSON.stringify(pending)))) throw new ProtocolError();
  return pending;
}
function requirePending(pending: Pending|null, request: PreparedSubmission): asserts pending is Pending {
  if (!pending || !equal(pending.request,request)) throw new Error("The original submission was processed or changed. Reopen the paper.");
}
function filename(request: PreparedSubmission, kind: string): string { return "submit-" + request.id + "-" + kind + ".json"; }
async function retire(tree: AnchoredFiles, root: string, request: PreparedSubmission, kind: string): Promise<void> {
  const dir = join(root,state);
  tree.rename(join(dir,pendingPush),join(dir,filename(request,kind)),"publish");
  await tree.sync(dir);
}
function nextBinding(binding: RemoteBinding|null, request: PreparedSubmission, receipt: PushReceipt, checkedAt: string): RemoteBinding {
  const {snapshot,proposal} = receipt;
  if (!proposal) {
    return {schemaVersion:1,origin:request.origin,paperId:snapshot.paperId,acceptedBase:snapshot,workingBase:snapshot,lastSubmitted:snapshot,activePr:null,checkedAt};
  }
  if (!binding || binding.paperId !== snapshot.paperId || binding.origin !== request.origin) throw new ProtocolError();
  const next: RemoteBinding = {...binding,lastSubmitted:snapshot,checkedAt,activePr:null};
  if (snapshot.status === "superseded") next.proposalSource = {...proposal,snapshot};
  else {
    next.activePr = {id:proposal.id,owner:request.username,submissionId:snapshot.submissionId,hash:snapshot.hash,status:snapshot.status};
    delete next.proposalSource;
  }
  return next;
}

function rejection(status: number, body: Uint8Array): "retry"|"terminal"|"unknown" {
  try {
    const code = object(object(decodeJson(body)).error).code;
    if ((status === 401 && code === "invalid_token") || (status === 429 && code === "rate_limited")) return "retry";
    if ((status === 400 && code === "invalid_document") || (status === 409 &&
      (code === "stale_base" || code === "stale_pr" || code === "license_mismatch" || code === "license_required"))) return "terminal";
  } catch { /* Unrecognized error bodies cannot retire the request. */ }
  return "unknown";
}

export class SubmissionJournal {
  constructor(private readonly locked: Storage) {}

  async pending(root: string): Promise<PreparedSubmission|null> {
    return this.locked(root,async (tree: AnchoredFiles): Promise<PreparedSubmission|null> => (await readPending(tree,root))?.request ?? null);
  }

  async persistRequest(root: string, input: PreparedSubmission, expectedDigest?: string|null, live?: ()=>boolean): Promise<void> {
    const request = decodeRequest(input);
    await this.locked(root,async (tree: AnchoredFiles, readCurrent: ()=>Promise<ProjectSnapshot>): Promise<void> => {
      if (await readPending(tree,root)) throw new Error("A submission is awaiting confirmation. Retry the saved request.");
      const {binding,digest,pendingImport,pendingMerge} = await readVersion(tree,root);
      if (pendingImport || pendingMerge || (expectedDigest !== undefined && expectedDigest !== digest)) throw new Error("Check the paper binding and recover any unfinished operation first.");
      const {paper_id,base_hash,pull_request_id,expected_head,explanation,ai_assisted,...doc} = frozenPayload(request);
      if (binding ? binding.origin !== request.origin || binding.paperId !== paper_id || binding.acceptedBase.hash !== base_hash : paper_id !== null)
        throw new Error("The submission base changed. Review it again.");
      if (pull_request_id) {
        const head = binding?.activePr;
        const confirmed = head ? head.id === pull_request_id && head.hash === expected_head && head.owner === request.username && head.status === "pending"
          : !!binding && binding.workingBase.hash === expected_head && binding.workingBase.manifest.contributor_name === request.username;
        if (!confirmed) throw new Error("The proposal head changed. Review it again.");
      }
      const dir = join(root,state);
      await tree.directories(dir);
      for (const kind of ["complete","rejected","receipt"]) {
        if (await tree.source(join(dir,filename(request,kind)))) throw new Error("This request has already been processed. Check the original submission.");
      }
      const current = await readCurrent();
      if (current.revision !== request.sourceRevision || !equal(doc,publication(current))) throw new Error("The manuscript changed. Preview it again before confirming.");
      if (live && !live()) throw new Error("Submission canceled.");
      const pending = {request,previous:digest};
      await put(tree,root,pendingPush,{...pending,digest:sourceDigest(Buffer.from(JSON.stringify(pending)))});
    });
  }

  private async finish(tree: AnchoredFiles, root: string, pending: Pending, saved: SavedReceipt): Promise<VerifiedSnapshot> {
    const {request,previous} = pending;
    if (saved.id !== request.id || saved.payloadDigest !== request.payloadDigest || new Date(saved.checkedAt).toISOString() !== saved.checkedAt) throw new ProtocolError();
    const receipt = verifyReceipt(request,saved.raw);
    const {binding,digest} = await readVersion(tree,root);
    const next = nextBinding(binding,request,receipt,saved.checkedAt);
    if (digest === previous) {
      if (request.intent === "new-pr" && (binding?.activePr?.id === receipt.proposal!.id || binding?.proposalSource?.id === receipt.proposal!.id)) throw new ProtocolError();
      await writeVersion(tree,root,next,previous,undefined,request.id);
    } else if (!await isBindingSuccessor(tree,root,next,previous)) throw new Error("The paper binding changed. Review the saved receipt.");
    await retire(tree,root,request,"complete");
    return receipt.snapshot;
  }

  async hasReceipt(root: string, request: PreparedSubmission): Promise<boolean> {
    return this.locked(root,async (tree: AnchoredFiles): Promise<boolean> => {
      requirePending(await readPending(tree,root),request);
      return !!await this.saved(tree,root,request);
    });
  }

  async recoverReceipt(root: string, displayed: PreparedSubmission): Promise<VerifiedSnapshot> {
    return this.locked(root,async (tree: AnchoredFiles): Promise<VerifiedSnapshot> => {
      const pending = await readPending(tree,root);
      requirePending(pending,displayed);
      const saved = await this.saved(tree,root,pending.request);
      if (!saved) throw new Error("This submission has no saved receipt.");
      return this.finish(tree,root,pending,saved);
    });
  }

  private async saved(tree: AnchoredFiles, root: string, request: PreparedSubmission): Promise<SavedReceipt|null> {
    const file = await tree.source(join(root,state,filename(request,"receipt")));
    return file ? JSON.parse(file.text) as SavedReceipt : null;
  }

  async retryPending(root: string, username: string, token: string, transport: Transport): Promise<VerifiedSnapshot> {
    const request = await this.pending(root);
    if (!request || username !== request.username) throw new Error("Connect the account that prepared this request.");
    return this.sendPrepared(root,request,token,transport);
  }

  async sendPrepared(root: string, input: PreparedSubmission, token: string, transport: Transport): Promise<VerifiedSnapshot> {
    const request = decodeRequest(input);
    requirePending(await this.pendingRecord(root),request);
    const account = await new PeerpediaApi(request.origin,transport).me(token);
    checkAccount(account,request.username,request.intent);
    // Each active or ambiguous POST owns an immutable marker until this exact attempt
    // receives a documented precommit rejection. No project lock spans a network call.
    const attempt = randomUUID();
    const attempts = join(root,state,"submit-attempts",request.id);
    const recovered = await this.locked(root,async (tree: AnchoredFiles): Promise<VerifiedSnapshot|null> => {
      const pending = await readPending(tree,root);
      requirePending(pending,request);
      const receipt = await this.saved(tree,root,request);
      if (receipt) return this.finish(tree,root,pending,receipt);
      await tree.directories(attempts);
      await tree.file(join(attempts,attempt),"");
      await tree.sync(attempts);
      return null;
    });
    if (recovered) return recovered;
    const result = await transport.request(request.origin,"/api/v1/push/","POST",{"Content-Type":"application/json",Accept:"application/json",
      Authorization:"Bearer " + token,"Idempotency-Key":request.id},Buffer.from(request.payloadJson,"utf8"));
    if (result.status !== 200 && result.status !== 201) {
      const outcome = rejection(result.status,result.body);
      if (outcome !== "unknown") await this.locked(root,async (tree: AnchoredFiles): Promise<void> => {
        requirePending(await readPending(tree,root),request);
        tree.rename(join(attempts,attempt),join(attempts,attempt+".closed"),"publish");
        await tree.sync(attempts);
        if (outcome === "terminal" && tree.list(attempts).every((name:string):boolean => name.endsWith(".closed")) && !await this.saved(tree,root,request))
          await retire(tree,root,request,"rejected");
      });
      throw new HttpStatusError(result.status);
    }
    const row = object(decodeJson(result.body));
    // Store only the protocol fields used to re-verify the receipt.
    const raw = {manifest:row.manifest,hash:row.hash,markdown:row.markdown,chapters:row.chapters,bibliography:row.bibliography,
      status:row.status,snapshot_identifier:row.snapshot_identifier,pull_request:row.pull_request,ai_assisted:row.ai_assisted};
    const incoming = verifyReceipt(request,raw);
    if (result.status === 201 && incoming.proposal && incoming.snapshot.status !== "pending") throw new ProtocolError();
    if (JSON.stringify(raw).includes(token)) throw new ProtocolError();
    return this.locked(root,async (tree: AnchoredFiles): Promise<VerifiedSnapshot> => {
      const pending = await readPending(tree,root);
      const saved = await this.saved(tree,root,request);
      if (saved && verifyReceipt(request,saved.raw).snapshot.hash !== incoming.snapshot.hash) throw new ProtocolError();
      if (saved && await tree.source(join(root,state,filename(request,"complete")))) return verifyReceipt(request,saved.raw).snapshot;
      requirePending(pending,request);
      const receipt = saved ?? {id:request.id,payloadDigest:request.payloadDigest,checkedAt:new Date().toISOString(),raw};
      if (!saved) {
        const {binding,digest} = await readVersion(tree,root);
        if (digest !== pending.previous || (request.intent === "new-pr" && (binding?.activePr?.id === object(row.pull_request).id
          || binding?.proposalSource?.id === object(row.pull_request).id))) throw new ProtocolError();
        await put(tree,root,filename(request,"receipt"),receipt);
      }
      return this.finish(tree,root,pending,receipt);
    });
  }

  private pendingRecord(root: string): Promise<Pending|null> {
    return this.locked(root,(tree: AnchoredFiles): Promise<Pending|null> => readPending(tree,root));
  }
}
