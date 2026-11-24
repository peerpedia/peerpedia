import { UserFacingError } from "../user-error";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AnchoredFiles } from "../project/anchored-files";
import { isMissing } from "../project/paths";
import { importedRevision } from "./import";
import { isUuid } from "./links";
import { exactOrigin } from "./transport";
import type { PrHead, RemoteBinding, VerifiedSnapshot } from "./types";
import { checksum, nonempty, object, ProtocolError, readStatus, verifySnapshot } from "./verify";

export interface BindingVersion {
  binding: RemoteBinding | null;
  digest: string | null;
  pendingImport: boolean;
  pendingMerge?: boolean;
  pendingSubmission?: boolean;
}

const state = ".peerpedia-obsidian";
const first = "binding.json";
const pending = "import-pending.json";
const history = "binding-history";

function snapshot(input: unknown, paperId: string): VerifiedSnapshot {
  const row = object(input);
  const doc = object(row.document);
  const result = verifySnapshot({manifest:row.manifest, hash:row.hash, status:row.status, snapshot_identifier:row.publicId,
    markdown:doc.markdown, chapters:doc.chapters, bibliography:doc.bibliography});
  if (result.paperId !== paperId || !isDeepStrictEqual(result,row)) throw new ProtocolError();
  return result;
}

function head(input: unknown): PrHead {
  const row = object(input);
  const status = readStatus(row.status);
  if (!isUuid(row.id) || !isUuid(row.submissionId) || status === "superseded") throw new ProtocolError();
  return {id:row.id,submissionId:row.submissionId,hash:checksum(row.hash),owner:nonempty(row.owner),status};
}

function checkedTime(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new ProtocolError();
  return value;
}

export function decodeBinding(input: unknown): RemoteBinding {
  const row = object(input);
  if (row.schemaVersion !== 1 || !isUuid(row.paperId) || typeof row.origin !== "string") throw new ProtocolError();
  exactOrigin(row.origin);
  const binding: RemoteBinding = {schemaVersion:1,paperId:row.paperId,origin:row.origin,checkedAt:checkedTime(row.checkedAt),
    acceptedBase:snapshot(row.acceptedBase,row.paperId),workingBase:snapshot(row.workingBase,row.paperId),
    activePr:row.activePr === null ? null : head(row.activePr),
    lastSubmitted:row.lastSubmitted === null ? null : snapshot(row.lastSubmitted,row.paperId)};
  if (Object.hasOwn(row,"proposalSource")) {
    const source = object(row.proposalSource);
    if (!isUuid(source.id) || typeof source.number !== "number" || !Number.isSafeInteger(source.number) || source.number < 1) throw new ProtocolError();
    binding.proposalSource = {id:source.id,number:source.number,snapshot:snapshot(source.snapshot,row.paperId)};
  }
  if (binding.acceptedBase.status !== "accepted" || !isDeepStrictEqual(binding,row)) throw new ProtocolError();
  return binding;
}

async function publish(tree: AnchoredFiles, dir: string, destination: string, text: string): Promise<void> {
  const staged = join(dir, ".binding-" + randomUUID());
  await tree.file(staged,text);
  tree.rename(staged,join(dir,destination),"publish");
  await tree.sync(dir);
}

// The first record and its successors are immutable. Exclusive publication at the next
// ordinal linearizes independent writers. Linking each record to its predecessor makes
// the revision distinct even when the binding returns to an earlier payload.
interface BindingHistory {
  binding: RemoteBinding | null;
  digest: string | null;
  count: number;
}

async function records(tree: AnchoredFiles, dir: string, visit?: (binding: RemoteBinding) => void, atDigest?: string): Promise<BindingHistory> {
  let names: string[];
  try { names = tree.list(join(dir,history)); }
  catch (error: unknown) { if (!isMissing(error)) throw error; names = []; }
  const initial = await tree.source(join(dir,first));
  if (!initial) {
    if (names.length) throw new UserFacingError("The initial version is missing from the binding history.");
    return {binding:null,digest:null,count:0};
  }
  const rootRecord = object(JSON.parse(initial.text));
  if (rootRecord.previous !== null) throw new UserFacingError("The initial binding version is invalid.");
  let binding = decodeBinding(rootRecord.binding);
  visit?.(binding);
  let digest = initial.digest;
  if (atDigest === digest) return {binding,digest,count:0};
  const expected = new Set(names);
  for (let index = 1; index <= names.length; ++index) {
    const name = index + ".json";
    if (!expected.has(name)) throw new UserFacingError("The binding history has a gap. Check the local binding.");
    const entry = await tree.source(join(dir,history,name));
    if (!entry) throw new UserFacingError("A binding history record is missing.");
    const record = object(JSON.parse(entry.text));
    if (record.previous !== digest || Object.keys(record).length !== 2) throw new UserFacingError("The binding history digest does not match.");
    if ("checkedAt" in record) binding = {...binding,checkedAt:checkedTime(record.checkedAt)};
    else {
      const next = decodeBinding(record.binding);
      if (next.origin !== binding.origin || next.paperId !== binding.paperId) throw new UserFacingError("The paper binding points to a different site or paper.");
      binding = next;
      visit?.(binding);
    }
    digest = entry.digest;
    if (atDigest === digest) return {binding,digest,count:index};
  }
  return {binding,digest,count:names.length};
}

export async function bindingAtDigest(tree:AnchoredFiles, root:string, expected:string):Promise<RemoteBinding> {
  const version = await records(tree,join(root,state),undefined,expected);
  if (version.digest !== expected || !version.binding) throw new UserFacingError("Could not verify the original binding for this submission.");
  return version.binding;
}

export async function readVersion(tree: AnchoredFiles, root: string): Promise<BindingVersion> {
  tree.directory(root);
  const dir = join(root,state);
  const {binding,digest} = await records(tree,dir);
  return {binding,digest,pendingSubmission:!!await tree.source(join(dir,"submit-pending.json")),pendingMerge:!!await tree.source(join(dir,"merge-pending.json")),pendingImport:!binding && !!await tree.source(join(dir,pending))};
}

export async function writeVersion(tree: AnchoredFiles, root: string, binding: RemoteBinding, expectedDigest: string | null, mergeTransaction?: string, submissionId?: string): Promise<void> {
  // This same descriptor already owns the lock during merge finalization.
  // Its enclosing anchored operation releases ownership when it closes.
  tree.lockProject(root);
  const dir = join(root,state);
  const {binding:previous,digest,count} = await records(tree,dir);
  const push = await tree.source(join(dir,"submit-pending.json"));
  if (push && (!submissionId || object(object(JSON.parse(push.text)).request).id !== submissionId)) throw new UserFacingError("Resolve the pending submission first.");
  const intent = await tree.source(join(dir,"merge-pending.json"));
  if (intent && (!mergeTransaction || object(JSON.parse(intent.text)).transaction !== mergeTransaction)) throw new UserFacingError("Resolve the unfinished merge first.");
  if (digest !== expectedDigest) throw new UserFacingError("The local binding changed. Check it again.");
  if (!previous && await tree.source(join(dir,pending))) throw new UserFacingError("Finish the import binding first.");
  if (!push && !await tree.source(join(root,"paper.json"))) throw new UserFacingError("The paper is missing paper.json.");
  const verified = decodeBinding(binding);
  if (previous && (previous.origin !== verified.origin || previous.paperId !== verified.paperId)) throw new UserFacingError("The paper binding points to a different site or paper.");
  if (isDeepStrictEqual(previous,verified)) return;
  const timeOnly = previous && isDeepStrictEqual({...previous,checkedAt:verified.checkedAt},verified);
  const record = timeOnly ? {previous:digest,checkedAt:verified.checkedAt} : {previous:digest,binding:verified};
  const folder = previous ? join(dir,history) : dir;
  await tree.directories(folder);
  // Staging names stay outside the ordinal-only history directory.
  const staged = join(dir,".binding-" + randomUUID());
  await tree.file(staged,JSON.stringify(record));
  tree.rename(staged, join(folder,previous ? (count + 1) + ".json" : first),"publish");
  await tree.sync(folder);
  if (folder !== dir) await tree.sync(dir);
}

export async function prepareImport(tree: AnchoredFiles, root: string, binding: RemoteBinding, revision: string): Promise<void> {
  const dir = join(root,state);
  await tree.directories(dir);
  await publish(tree,dir,pending,JSON.stringify({previous:null,binding:decodeBinding(binding),importRevision:revision}));
}

interface PendingImport {
  binding: RemoteBinding;
  revision: string;
  digest: string;
}

export async function readPendingImport(tree: AnchoredFiles, root: string): Promise<PendingImport> {
  const dir = join(root,state);
  if (await tree.source(join(dir,first))) throw new UserFacingError("The paper already has a binding. Reopen the paper panel to check it.");
  const staged = await tree.source(join(dir,pending));
  if (!staged) throw new UserFacingError("No pending import binding was found.");
  const record = object(JSON.parse(staged.text));
  const binding = decodeBinding(record.binding);
  const revision = checksum(record.importRevision);
  if (record.previous !== null || importedRevision(binding.workingBase) !== revision) throw new UserFacingError("The import recovery record does not match the working snapshot.");
  return {binding,revision,digest:staged.digest};
}

export async function finishImport(tree: AnchoredFiles, root: string, revision: string, binding: RemoteBinding): Promise<void> {
  const intent = await readPendingImport(tree,root);
  if (intent.revision !== revision || !isDeepStrictEqual(intent.binding,binding)) throw new UserFacingError("The imported files or binding changed. Check the recovery record.");
  const dir = join(root,state);
  tree.rename(join(dir,pending),join(dir,first),"publish");
  await tree.sync(dir);
  if ((await tree.source(join(dir,first)))?.digest !== intent.digest) throw new UserFacingError("The import binding could not be confirmed. Open the paper panel to check it.");
}

export async function isBindingSuccessor(tree: AnchoredFiles, root: string, binding: RemoteBinding, previous: string|null): Promise<boolean> {
  const dir = join(root,state);
  const tip = await records(tree,dir);
  if (!isDeepStrictEqual(tip.binding,binding)) return false;
  if (!tip.count) return previous === null;
  const entry = await tree.source(join(dir,history,tip.count + ".json"));
  return !!entry && object(JSON.parse(entry.text)).previous === previous;
}

// Only full, verified records where the confirmed working snapshot was the
// bound PR head qualify. Timestamp observations never introduce a candidate.
export async function readProposalBase(tree: AnchoredFiles, root: string, proposalId: string, digest: string): Promise<VerifiedSnapshot|null> {
  let candidate: VerifiedSnapshot|null = null;
  const tip = await records(tree,join(root,state),(binding: RemoteBinding): void => {
    const {activePr,workingBase} = binding;
    if (activePr?.id === proposalId && activePr.hash === workingBase.hash && activePr.submissionId === workingBase.submissionId)
      candidate = workingBase;
  });
  if (tip.digest !== digest) throw new UserFacingError("The local binding changed. Compare the versions again.");
  return candidate;
}
