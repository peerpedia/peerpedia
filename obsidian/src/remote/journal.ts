import { UserFacingError } from "../user-error";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import type { AnchoredFiles } from "../project/anchored-files";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import { decodeJson, HttpStatusError, PeerpediaApi } from "./api";
import { sourceDigest } from "../project/store";
import { bindingAtDigest, isBindingSuccessor, readVersion, writeVersion } from "./binding";
import { checkAccount, decodeRequest, frozenPayload, publication, verifyReceipt, type AppendHead, type PreparedSubmission, type PushReceipt } from "./submit";
import type { RemoteBinding, Transport, VerifiedSnapshot } from "./types";
import { isUuid } from "./links";
import { checksum, object, ProtocolError } from "./verify";

const state = ".peerpedia-obsidian";
export const pendingPush = "submit-pending.json";
type Storage = <T>(root:string, operation:(tree:AnchoredFiles, readCurrent:()=>Promise<ProjectSnapshot>)=>Promise<T>)=>Promise<T>;
type Predecessor = Omit<AppendHead,"number"> & {number:number|null};
interface Pending {request:PreparedSubmission; previous:string|null; head?:Predecessor}
interface SavedReceipt {id:string; payloadDigest:string; checkedAt:string; httpStatus:200|201; raw:unknown}

interface StoredReceipt {present:boolean; verified:SavedReceipt|null}

function digestRecord(record:object):string { return sourceDigest(Buffer.from(JSON.stringify(record))); }

function predecessor(value:unknown, request:PreparedSubmission):Predecessor {
  const raw = object(value), payload = frozenPayload(request);
  if (request.intent !== "append-pr" || !isUuid(raw.id) || raw.id !== payload.pull_request_id || !isUuid(raw.submissionId)
    || raw.hash !== payload.expected_head || (raw.number !== null && (typeof raw.number !== "number" || !Number.isSafeInteger(raw.number) || raw.number < 1)))
    throw new ProtocolError();
  return {id:raw.id,submissionId:raw.submissionId,hash:checksum(raw.hash),number:raw.number};
}

function resultReceipt(request:PreparedSubmission, saved:SavedReceipt, head:AppendHead|null):PushReceipt {
  if (saved.id !== request.id || saved.payloadDigest !== request.payloadDigest || (saved.httpStatus !== 200 && saved.httpStatus !== 201)
    || typeof saved.checkedAt !== "string" || new Date(saved.checkedAt).toISOString() !== saved.checkedAt) throw new ProtocolError();
  const receipt = verifyReceipt(request,saved.raw,head);
  if (saved.httpStatus === 201 && receipt.proposal && receipt.snapshot.status !== "pending") throw new ProtocolError();
  return receipt;
}

async function put(tree: AnchoredFiles, root: string, name: string, data: unknown, mode:"publish"|"swap"="publish"): Promise<void> {
  const dir = join(root,state);
  // A swap leaves the exact previous bytes at the staging path, including
  // malformed JSON or an old unsigned receipt. Keep that evidence on disk.
  const stage = join(dir,mode === "swap" ? name + ".replaced-" + randomUUID() : ".submit-" + randomUUID());
  await tree.file(stage,JSON.stringify(data));
  tree.rename(stage,join(dir,name),mode);
  await tree.sync(dir);
}

async function readPending(tree: AnchoredFiles, root: string): Promise<Pending|null> {
  const file = await tree.source(join(root,state,pendingPush));
  if (!file) return null;
  const row = object(JSON.parse(file.text));
  const pending:Pending = {request:decodeRequest(row.request),previous:row.previous === null ? null : checksum(row.previous)};
  if (row.head !== undefined) pending.head = predecessor(row.head,pending.request);
  if (row.digest !== digestRecord(pending)) throw new ProtocolError();
  if (pending.request.intent === "append-pr" && !pending.head) {
    // Pre-proof journals still contain the immutable expected hash; recover its local identity before an exact GET.
    if (!pending.previous) throw new ProtocolError();
    const binding = await bindingAtDigest(tree,root,pending.previous);
    const payload = frozenPayload(pending.request);
    const prior = binding.activePr && binding.activePr.hash === payload.expected_head ? binding.activePr : binding.workingBase;
    if (!prior) throw new ProtocolError();
    pending.head = predecessor({id:payload.pull_request_id,hash:prior.hash,submissionId:prior.submissionId,number:null},pending.request);
  }
  return pending;
}
function requirePending(pending: Pending|null, request: PreparedSubmission): asserts pending is Pending {
  if (!pending || !equal(pending.request,request)) throw new UserFacingError("The original submission was processed or changed. Reopen the paper.");
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
  if (request.intent === "new-pr" && (binding.activePr?.id === proposal.id || binding.proposalSource?.id === proposal.id)) throw new ProtocolError();
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

  async persistRequest(root: string, input: PreparedSubmission, expectedDigest?: string|null, live?: ()=>boolean, reviewed?:AppendHead|null): Promise<void> {
    const request = decodeRequest(input);
    await this.locked(root,async (tree: AnchoredFiles, readCurrent: ()=>Promise<ProjectSnapshot>): Promise<void> => {
      if (await readPending(tree,root)) throw new UserFacingError("A submission is awaiting confirmation. Retry the saved request.");
      const {binding,digest,pendingImport,pendingMerge} = await readVersion(tree,root);
      if (pendingImport || pendingMerge || (expectedDigest !== undefined && expectedDigest !== digest)) throw new UserFacingError("Check the paper binding and recover any unfinished operation first.");
      const {paper_id,base_hash,pull_request_id,expected_head,explanation,ai_assisted,...doc} = frozenPayload(request);
      if (binding ? binding.origin !== request.origin || binding.paperId !== paper_id || binding.acceptedBase.hash !== base_hash : paper_id !== null)
        throw new UserFacingError("The submission base changed. Review it again.");
      const pending:Pending = {request,previous:digest};
      if (pull_request_id) {
        const head = binding?.activePr;
        const confirmed = head ? head.id === pull_request_id && head.hash === expected_head && head.owner === request.username && head.status === "pending"
          : !!binding && binding.workingBase.hash === expected_head && binding.workingBase.manifest.contributor_name === request.username;
        if (!confirmed) throw new UserFacingError("The proposal head changed. Review it again.");
        const prior = head ?? binding!.workingBase;
        pending.head = predecessor({id:pull_request_id,hash:prior.hash,submissionId:prior.submissionId,number:reviewed?.number ?? null},request);
        if (reviewed && !equal(reviewed,pending.head)) throw new ProtocolError();
      }
      const dir = join(root,state);
      await tree.directories(dir);
      for (const kind of ["complete","rejected","receipt"]) {
        if (await tree.source(join(dir,filename(request,kind)))) throw new UserFacingError("This request has already been processed. Check the original submission.");
      }
      const current = await readCurrent();
      if (current.revision !== request.sourceRevision || !equal(doc,publication(current))) throw new UserFacingError("The manuscript changed. Preview it again before confirming.");
      if (live && !live()) throw new UserFacingError("Submission canceled.");
      await put(tree,root,pendingPush,{...pending,digest:digestRecord(pending)});
    });
  }

  private async storedHead(tree:AnchoredFiles, root:string, pending:Pending):Promise<AppendHead|null> {
    const {head,request} = pending;
    if (!head) return null;
    if (head.number !== null) return {...head,number:head.number};
    const file = await tree.source(join(root,state,filename(request,"predecessor")));
    if (!file) return null;
    const {digest,...record} = object(JSON.parse(file.text));
    const prior = predecessor(record.head,request);
    if (digest !== digestRecord(record) || record.requestId !== request.id || prior.submissionId !== head.submissionId || prior.number === null)
      throw new ProtocolError();
    return {...prior,number:prior.number};
  }

  private async finish(tree: AnchoredFiles, root: string, pending: Pending, saved: SavedReceipt,
    write?: "publish"|"swap"): Promise<VerifiedSnapshot> {
    const {request,previous} = pending;
    const receipt = resultReceipt(request,saved,await this.storedHead(tree,root,pending));
    const {binding,digest} = await readVersion(tree,root);
    const committed = digest !== previous;
    // Reconstruct from the original CAS parent. Starting from the current
    // binding would copy its accepted/working axes into the supposed proof.
    let target:RemoteBinding;
    if (committed) {
      if (!binding?.lastSubmitted) throw new ProtocolError();
      const parent = previous ? await bindingAtDigest(tree,root,previous) : null;
      const status = binding.lastSubmitted.status;
      // Concurrent responses can arrive out of order. The same proposal cannot
      // have two distinct terminal dispositions.
      if (status !== receipt.snapshot.status && status !== "pending" && receipt.snapshot.status !== "pending") throw new ProtocolError();
      // The server can now report acceptance or supersession. Only disposition
      // and check time come from the validated local record; the replay proves
      // every immutable snapshot field and the associated PR ID and ordinal.
      const localReceipt:PushReceipt = {...receipt,snapshot:{...receipt.snapshot,status}};
      target = nextBinding(parent,request,localReceipt,binding.checkedAt);
      if (!await isBindingSuccessor(tree,root,target,previous)) throw new UserFacingError("The paper binding changed. Review the saved receipt.");
    } else target = nextBinding(binding,request,receipt,saved.checkedAt);
    if (write) await put(tree,root,filename(request,"receipt"),{...saved,digest:digestRecord(saved)},write);
    if (!committed) await writeVersion(tree,root,target,previous,undefined,request.id);
    await retire(tree,root,request,"complete");
    return receipt.snapshot;
  }

  async hasReceipt(root: string, request: PreparedSubmission): Promise<boolean> {
    return this.locked(root,async (tree: AnchoredFiles): Promise<boolean> => {
      const pending = await readPending(tree,root);
      requirePending(pending,request);
      return !!(await this.saved(tree,root,request,await this.storedHead(tree,root,pending))).verified;
    });
  }

  async recoverReceipt(root: string, displayed: PreparedSubmission): Promise<VerifiedSnapshot> {
    return this.locked(root,async (tree: AnchoredFiles): Promise<VerifiedSnapshot> => {
      const pending = await readPending(tree,root);
      requirePending(pending,displayed);
      const saved = await this.saved(tree,root,pending.request,await this.storedHead(tree,root,pending));
      if (!saved.verified) throw new UserFacingError("A verified receipt is unavailable. Retry the saved submission to retrieve it.");
      return this.finish(tree,root,pending,saved.verified);
    });
  }

  private async saved(tree: AnchoredFiles, root: string, request: PreparedSubmission, head:AppendHead|null): Promise<StoredReceipt> {
    const path = join(root,state,filename(request,"receipt"));
    let file:SourceFile|undefined;
    try { file = await tree.source(path); }
    catch (error:unknown) {
      if (!(error instanceof TypeError)) throw error;
      // A fatal UTF-8 decoding failure leaves a real file to preserve. Verify
      // its presence through the anchored descriptor; propagate filesystem errors.
      tree.mode(path);
      return {present:true,verified:null};
    }
    if (!file) return {present:false,verified:null};
    try {
      const {digest,...record} = object(JSON.parse(file.text));
      if (digest !== digestRecord(record) || record.id !== request.id || record.payloadDigest !== request.payloadDigest
        || typeof record.checkedAt !== "string" || (record.httpStatus !== 200 && record.httpStatus !== 201)) throw new ProtocolError();
      const verified:SavedReceipt = {id:request.id,payloadDigest:request.payloadDigest,checkedAt:record.checkedAt,httpStatus:record.httpStatus,raw:record.raw};
      resultReceipt(request,verified,head);
      return {present:true,verified};
    } catch {
      // Unusable receipts never authorize offline promotion or a fresh UUID.
      // The original authenticated replay can replace them after full verification.
      return {present:true,verified:null};
    }
  }

  async retryPending(root: string, username: string, token: string, transport: Transport): Promise<VerifiedSnapshot> {
    const request = await this.pending(root);
    if (!request || username !== request.username) throw new UserFacingError("Connect the account that prepared this request.");
    return this.sendPrepared(root,request,token,transport);
  }

  async sendPrepared(root: string, input: PreparedSubmission, token: string, transport: Transport): Promise<VerifiedSnapshot> {
    const request = decodeRequest(input);
    const initial = await this.pendingRecord(root);
    requirePending(initial,request);
    const api = new PeerpediaApi(request.origin,transport);
    const account = await api.me(token);
    checkAccount(account,request.username,request.intent);
    let head = await this.locked(root,(tree:AnchoredFiles):Promise<AppendHead|null> => this.storedHead(tree,root,initial));
    if (initial.head && !head) {
      const previous = initial.head;
      const exact = await api.proposalSnapshot(previous.submissionId);
      if (exact.proposal?.id !== previous.id || exact.snapshot.submissionId !== previous.submissionId || exact.snapshot.hash !== previous.hash
        || exact.snapshot.paperId !== frozenPayload(request).paper_id || exact.snapshot.manifest.contributor_name !== request.username) throw new ProtocolError();
      const proof:AppendHead = {...previous,number:exact.proposal.number};
      await this.locked(root,async (tree:AnchoredFiles):Promise<void> => {
        const pending = await readPending(tree,root);
        requirePending(pending,request);
        const existing = await this.storedHead(tree,root,pending);
        if (existing) { if (!equal(existing,proof)) throw new ProtocolError(); return; }
        const record = {requestId:request.id,head:proof};
        await put(tree,root,filename(request,"predecessor"),{...record,digest:digestRecord(record)});
      });
      head = proof;
    }
    // Each active or ambiguous POST owns an immutable marker until this exact attempt
    // receives a documented precommit rejection. No project lock spans a network call.
    const attempt = randomUUID();
    const attempts = join(root,state,"submit-attempts",request.id);
    const recovered = await this.locked(root,async (tree: AnchoredFiles): Promise<VerifiedSnapshot|null> => {
      const pending = await readPending(tree,root);
      requirePending(pending,request);
      const stored = await this.saved(tree,root,request,head);
      if (stored.verified) return this.finish(tree,root,pending,stored.verified);
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
        if (outcome === "terminal" && tree.list(attempts).every((name:string):boolean => name.endsWith(".closed")) && !(await this.saved(tree,root,request,head)).present)
          await retire(tree,root,request,"rejected");
      });
      throw new HttpStatusError(result.status);
    }
    const raw = object(decodeJson(result.body));
    const incomingRecord:SavedReceipt = {id:request.id,payloadDigest:request.payloadDigest,checkedAt:new Date().toISOString(),httpStatus:result.status,raw};
    const incoming = resultReceipt(request,incomingRecord,head);
    if (JSON.stringify(raw).includes(JSON.stringify(token).slice(1,-1))) throw new ProtocolError();
    return this.locked(root,async (tree: AnchoredFiles): Promise<VerifiedSnapshot> => {
      const pending = await readPending(tree,root);
      const stored = await this.saved(tree,root,request,head);
      if (stored.verified) {
        const previous = resultReceipt(request,stored.verified,head);
        if (previous.snapshot.hash !== incoming.snapshot.hash || !equal(previous.proposal,incoming.proposal)) throw new ProtocolError();
        if (await tree.source(join(root,state,filename(request,"complete")))) return previous.snapshot;
      }
      requirePending(pending,request);
      if (stored.verified) return this.finish(tree,root,pending,stored.verified);
      if (stored.present && result.status !== 200) throw new ProtocolError();
      return this.finish(tree,root,pending,incomingRecord,stored.present ? "swap" : "publish");
    });
  }

  private pendingRecord(root: string): Promise<Pending|null> {
    return this.locked(root,(tree: AnchoredFiles): Promise<Pending|null> => readPending(tree,root));
  }
}
