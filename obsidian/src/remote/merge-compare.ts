import { isDeepStrictEqual as equal } from "node:util";
import { toPublicationDocument } from "../project/publication";
import { parsePaperConfig, projectMembers, projectRevision, sourceDigest, type FileChange, type ProjectStore } from "../project/store";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import { HttpStatusError, type PeerpediaApi, type ProposalSnapshot } from "./api";
import { checkRemote } from "./controller";
import { manualMerge, mergeDocuments, plannedResult, type MergeResult } from "./merge";
import type { RemoteBinding, RemoteCheck, VerifiedSnapshot } from "./types";

export type MergeAxis = "accepted"|"proposal";
export interface Comparison {
  axis: MergeAxis;
  base: VerifiedSnapshot|null;
  target: VerifiedSnapshot;
  check: RemoteCheck;
  result: MergeResult;
}
interface Session {
  binding: RemoteBinding;
  digest: string;
  project: ProjectSnapshot;
  selectedPr?: string;
  comparison: Comparison;
}
const sessions = new WeakMap<RemoteCheck,Session>();

function matches(a: VerifiedSnapshot, b: VerifiedSnapshot): boolean {
  return a.hash === b.hash && a.submissionId === b.submissionId && a.paperId === b.paperId;
}

async function receipt(api: PeerpediaApi, saved: VerifiedSnapshot): Promise<ProposalSnapshot> {
  const response = await api.proposalSnapshot(saved.submissionId);
  if (!matches(response.snapshot,saved)) throw new Error("提案快照身份不符，请重新比较。");
  return response;
}

function acceptedAncestor(binding: RemoteBinding, target: VerifiedSnapshot): VerifiedSnapshot|null {
  const {workingBase:working,lastSubmitted:submitted,acceptedBase:accepted} = binding;
  if (submitted && matches(submitted,target)) return submitted;
  if (matches(working,target) || target.manifest.base_hash === working.hash) return working;
  if (working.manifest.base_hash === target.hash) return target;
  // A digest-verified base_hash in each manifest identifies the common accepted
  // parent. A stored accepted head alone says nothing about a historical import.
  if (working.manifest.base_hash === accepted.hash && target.manifest.base_hash === accepted.hash) return accepted;
  return null;
}

async function proposalAncestor(binding: RemoteBinding, latest: ProposalSnapshot, history: VerifiedSnapshot|null, api: PeerpediaApi): Promise<VerifiedSnapshot|null> {
  let best: VerifiedSnapshot|null = null, ordinal = 0;
  const sources = new Map<string,VerifiedSnapshot>();
  for (const source of [binding.workingBase,binding.lastSubmitted,history]) if (source) sources.set(source.hash,source);
  // When a confirmed head is still bound, earlier submissions cannot be
  // newer common snapshots. Fetch its exact receipt once, even across axes.
  const previousHead = binding.activePr;
  const confirmed = previousHead && sources.get(previousHead.hash);
  if (previousHead && (!confirmed || confirmed.submissionId !== previousHead.submissionId)) return null;
  const candidates = confirmed ? [confirmed] : sources.values();
  for (const saved of candidates) {
    if (matches(saved,latest.snapshot)) return saved;
    if (saved.status === "accepted") continue;
    let old: ProposalSnapshot;
    try { old = await receipt(api,saved); }
    catch (error: unknown) { if (error instanceof HttpStatusError && error.status === 404) return null; throw error; }
    if ((saved.hash === history?.hash || saved.hash === previousHead?.hash)
      && (!old.proposal || old.proposal.id !== latest.proposal?.id || old.proposal.number >= latest.proposal.number)) return null;
    if (old.proposal && latest.proposal && old.proposal.id === latest.proposal.id && old.proposal.number < latest.proposal.number
      && old.proposal.number > ordinal) {
      best = saved;
      ordinal = old.proposal.number;
    }
  }
  // On an already bound proposal its accepted base is never a substitute
  // for the missing common proposal snapshot.
  return best;
}

export async function prepareMerge(project: ProjectSnapshot, axis: MergeAxis, store: ProjectStore, api: PeerpediaApi): Promise<Comparison> {
  const version = await store.readBindingVersion?.(project.root);
  if (!version?.binding || !version.digest || version.pendingMerge) throw new Error("请先核对项目绑定或恢复未完成的合并。");
  const {binding,digest} = version;
  if (binding.origin !== api.origin) throw new Error("比较站点与绑定不符。");
  const saved = binding.lastSubmitted ?? binding.workingBase;
  let selectedPr = binding.activePr?.id;
  if (!selectedPr && saved.status !== "accepted") selectedPr = (await receipt(api,saved)).proposal?.id;
  const check = await checkRemote(binding,api,selectedPr);
  let target = check.current, base: VerifiedSnapshot|null;
  if (axis === "proposal") {
    const head = check.activePr;
    if (!head || head.status !== "pending") throw new Error("没有可比较的开放提案。");
    const latest = await api.proposalSnapshot(head.submissionId);
    target = latest.snapshot;
    if (latest.proposal?.id !== head.id || target.paperId !== binding.paperId || target.status !== head.status
      || target.submissionId !== head.submissionId || target.hash !== head.hash) throw new Error("提案版本已变化，请重新比较。");
    const history = await store.readProposalBase?.(project.root,head.id,digest) ?? null;
    base = await proposalAncestor(binding,latest,history,api);
  } else base = acceptedAncestor(binding,target);
  const local = toPublicationDocument(project);
  const result = base ? mergeDocuments(base.document,local,target.document) : manualMerge(local,target.document);
  const comparison = {axis,base,target,result,check};
  sessions.set(check,{binding,digest,project,comparison,selectedPr});
  return comparison;
}

function projectedRevision(project: ProjectSnapshot, changes: readonly FileChange[]): string {
  const files = new Map(project.files.map((file: SourceFile): [string,SourceFile] => [file.path,file]));
  for (const {path,afterText} of changes) {
    if (afterText === null) files.delete(path);
    else files.set(path,{path,text:afterText,digest:sourceDigest(Buffer.from(afterText))});
  }
  const config = parsePaperConfig(files.get("paper.json")!.text);
  return projectRevision(projectMembers(config).map((path:string): SourceFile => {
    const file = files.get(path);
    if (!file) throw new Error("缺少合并文件：" + path);
    return file;
  }));
}

export async function applyMerge(project: ProjectSnapshot, changes: readonly FileChange[], check: RemoteCheck, store: ProjectStore, api: PeerpediaApi,
  live: () => boolean = (): boolean => true): Promise<ProjectSnapshot> {
  const session = sessions.get(check);
  if (!session || session.project.root !== project.root || session.project.revision !== project.revision ||
    plannedResult(project,changes) !== session.comparison.result) throw new Error("请先完成本次比较并确认全部冲突。");
  const {comparison,binding,digest,selectedPr} = session;
  const version = await store.readBindingVersion?.(project.root);
  if (version?.digest !== digest || version.pendingMerge || (await store.read(project.root)).revision !== project.revision)
    throw new Error("本地论文或绑定已更改，请重新比较。");
  const now = await checkRemote(binding,api,selectedPr);
  if (!matches(check.current,now.current) || !equal(check.activePr,now.activePr)) throw new Error("远程版本已更改，请重新比较。");
  if (!live()) throw new Error("已取消合并。");
  const next = {...binding,workingBase:comparison.target,checkedAt:now.checkedAt};
  if (comparison.axis === "accepted") next.acceptedBase = now.current;
  else next.activePr = now.activePr;
  return store.apply(project.root,project.revision,changes,{binding:next,expectedDigest:digest,revision:projectedRevision(project,changes)});
}
