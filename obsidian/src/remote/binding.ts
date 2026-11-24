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

async function records(tree: AnchoredFiles, dir: string, visit?: (binding: RemoteBinding) => void): Promise<BindingHistory> {
  let names: string[];
  try { names = tree.list(join(dir,history)); }
  catch (error: unknown) { if (!isMissing(error)) throw error; names = []; }
  const initial = await tree.source(join(dir,first));
  if (!initial) {
    if (names.length) throw new Error("绑定历史缺少初始版本。");
    return {binding:null,digest:null,count:0};
  }
  const rootRecord = object(JSON.parse(initial.text));
  if (rootRecord.previous !== null) throw new Error("绑定初始版本无效。");
  let binding = decodeBinding(rootRecord.binding);
  visit?.(binding);
  let digest = initial.digest;
  const expected = new Set(names);
  for (let index = 1; index <= names.length; ++index) {
    const name = index + ".json";
    if (!expected.has(name)) throw new Error("绑定历史不连续，请核对本地状态。");
    const entry = await tree.source(join(dir,history,name));
    if (!entry) throw new Error("绑定历史记录缺失。");
    const record = object(JSON.parse(entry.text));
    if (record.previous !== digest || Object.keys(record).length !== 2) throw new Error("绑定历史摘要不一致。");
    if ("checkedAt" in record) binding = {...binding,checkedAt:checkedTime(record.checkedAt)};
    else {
      const next = decodeBinding(record.binding);
      if (next.origin !== binding.origin || next.paperId !== binding.paperId) throw new Error("论文绑定身份已更改。");
      binding = next;
      visit?.(binding);
    }
    digest = entry.digest;
  }
  return {binding,digest,count:names.length};
}

export async function readVersion(tree: AnchoredFiles, root: string): Promise<BindingVersion> {
  tree.directory(root);
  const dir = join(root,state);
  const {binding,digest} = await records(tree,dir);
  return {binding,digest,pendingMerge:!!await tree.source(join(dir,"merge-pending.json")),pendingImport:!binding && !!await tree.source(join(dir,pending))};
}

export async function writeVersion(tree: AnchoredFiles, root: string, binding: RemoteBinding, expectedDigest: string | null, mergeTransaction?: string): Promise<void> {
  // This same descriptor already owns the lock during merge finalization.
  // Its enclosing anchored operation releases ownership when it closes.
  tree.lockProject(root);
  const dir = join(root,state);
  const {binding:previous,digest,count} = await records(tree,dir);
  const intent = await tree.source(join(dir,"merge-pending.json"));
  if (intent && (!mergeTransaction || object(JSON.parse(intent.text)).transaction !== mergeTransaction)) throw new Error("请先处理未完成的合并。");
  if (digest !== expectedDigest) throw new Error("本地绑定已更改，请重新检查。");
  if (!previous && await tree.source(join(dir,pending))) throw new Error("请先完成导入绑定。");
  if (!await tree.source(join(root,"paper.json"))) throw new Error("论文缺少 paper.json。");
  const verified = decodeBinding(binding);
  if (previous && (previous.origin !== verified.origin || previous.paperId !== verified.paperId)) throw new Error("论文绑定身份已更改。");
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
  if (await tree.source(join(dir,first))) throw new Error("论文已有正式绑定，请重新打开面板核对。");
  const staged = await tree.source(join(dir,pending));
  if (!staged) throw new Error("找不到待完成的导入绑定。");
  const record = object(JSON.parse(staged.text));
  const binding = decodeBinding(record.binding);
  const revision = checksum(record.importRevision);
  if (record.previous !== null || importedRevision(binding.workingBase) !== revision) throw new Error("待恢复的导入记录与工作快照不符。");
  return {binding,revision,digest:staged.digest};
}

export async function finishImport(tree: AnchoredFiles, root: string, revision: string, binding: RemoteBinding): Promise<void> {
  const intent = await readPendingImport(tree,root);
  if (intent.revision !== revision || !isDeepStrictEqual(intent.binding,binding)) throw new Error("导入文件或绑定已更改，请核对恢复记录。");
  const dir = join(root,state);
  tree.rename(join(dir,pending),join(dir,first),"publish");
  await tree.sync(dir);
  if ((await tree.source(join(dir,first)))?.digest !== intent.digest) throw new Error("无法确认导入绑定，请打开论文面板核对。");
}

export async function isBindingSuccessor(tree: AnchoredFiles, root: string, binding: RemoteBinding, previous: string): Promise<boolean> {
  const dir = join(root,state);
  const tip = await records(tree,dir);
  if (!tip.count || !isDeepStrictEqual(tip.binding,binding)) return false;
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
  if (tip.digest !== digest) throw new Error("本地绑定已更改，请重新比较。");
  return candidate;
}
