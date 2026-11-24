import { isDeepStrictEqual as equal } from "node:util";
import { inspectChapter } from "../../../editor/chapter-title.js";
import { toPublicationDocument, type PublicationDocument } from "../project/publication";
import { projectMembers, type FileChange } from "../project/store";
import type { ChapterSpec, ProjectSnapshot, SourceFile } from "../project/types";
import { mergeBibliography } from "./merge-bibliography";
import { mergeText } from "./merge-text";
import type { JsonValue } from "./types";

export { applyMerge, prepareMerge } from "./merge-compare";

export interface MergeConflict {
  id: string;
  kind: "text" | "chapter" | "order" | "metadata" | "bibliography";
  target: string;
  base: JsonValue;
  local: JsonValue;
  remote: JsonValue;
}
export interface MergeResult { candidate: PublicationDocument; conflicts: readonly MergeConflict[] }
type Choices = Readonly<Record<string,JsonValue>>;
type Decide = (kind: MergeConflict["kind"], target: string, base: JsonValue, local: JsonValue, remote: JsonValue) => JsonValue;
type Builder = (decide: Decide) => PublicationDocument;
type Chapter = PublicationDocument["chapters"][number];
const builders = new WeakMap<MergeResult,Builder>();
const resolutions = new WeakMap<PublicationDocument,MergeResult>();
const plans = new WeakMap<readonly FileChange[],{root: string; revision: string; result: MergeResult}>();
export function plannedResult(project: ProjectSnapshot, changes: readonly FileChange[]): MergeResult|undefined {
  const plan = plans.get(changes);
  return plan?.root === project.root && plan.revision === project.revision ? plan.result : undefined;
}
const previews = new WeakSet<PublicationDocument>();

function resultOf(build: Builder): MergeResult {
  const conflicts: MergeConflict[] = [];
  const candidate = build((kind: MergeConflict["kind"],target: string,base: JsonValue,local: JsonValue,remote: JsonValue): JsonValue => {
    conflicts.push({id:JSON.stringify([kind,target]),kind,target,base,local,remote});
    return local;
  });
  const result = {candidate,conflicts};
  if (conflicts.length) previews.add(candidate);
  if (!conflicts.length) resolutions.set(candidate,result);
  builders.set(result,build);
  return result;
}

function string(value: JsonValue): string {
  if (typeof value !== "string") throw new Error("此处需要文本。");
  return value;
}
function strings(value: JsonValue): string[] {
  if (!Array.isArray(value) || !value.every((item: JsonValue): item is string => typeof item === "string")) throw new Error("此处需要文本列表。");
  return value;
}
function select<T extends JsonValue>(base: T, local: T, remote: T, choose: () => JsonValue): JsonValue {
  if (equal(local,remote) || equal(base,remote)) return local;
  if (equal(base,local)) return remote;
  return choose();
}
function chapter(value: JsonValue): Chapter {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("章节格式无效。");
  return {id:string(value.id),title:string(value.title),markdown:string(value.markdown)};
}
function body(doc: PublicationDocument): {chapters: Chapter[];markdown:string} {
  return {chapters:[...doc.chapters],markdown:doc.markdown};
}
function parsedBody(value: JsonValue): ReturnType<typeof body> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.chapters)) throw new Error("请核对正文章节。");
  const chapters = value.chapters.map(chapter);
  return {chapters,markdown:chapters.length ? chapters.map((c: Chapter): string => c.markdown).join("\n\n") : string(value.markdown)};
}

function chapterOrder(base: string[], local: string[], remote: string[], decide: Decide): string[] {
  // Compare the order of surviving common IDs independently from membership.
  const common = base.filter((id: string): boolean => local.includes(id) && remote.includes(id));
  const core = (ids: string[]): string[] => ids.filter((id: string): boolean => common.includes(id));
  const left = core(local), right = core(remote);
  const preferred = equal(left,common) && !equal(right,common) ? remote : local;
  const all = new Set([...base,...local,...remote]);
  const complete = (chosen: string[]): string[] => {
    const order = [...chosen];
    if (new Set(order).size !== order.length || order.some((id: string): boolean => !all.has(id))) throw new Error("章节顺序含有重复或未知 ID。");
    for (const keys of [remote,local,base]) {
      for (const [i,id] of keys.entries()) if (!order.includes(id)) {
        const next = keys.slice(i+1).find((key: string): boolean => order.includes(key));
        order.splice(next === undefined ? order.length : order.indexOf(next),0,id);
      }
    }
    return order;
  };
  const order = complete(preferred);
  const misplaced = (side: string[]): boolean => side.some((id: string,index: number): boolean => !base.includes(id) &&
    side.some((other: string,j: number): boolean => (index < j) !== (order.indexOf(id) < order.indexOf(other))));
  if ((!equal(left,right) && !equal(common,left) && !equal(common,right)) || misplaced(local) || misplaced(remote))
    return complete(strings(decide("order","章节顺序",base,local,remote)));
  return order;
}

function mergeBody(base: PublicationDocument, local: PublicationDocument, remote: PublicationDocument, decide: Decide): ReturnType<typeof body> {
  const text = (target: string,b: string,l: string,r: string): string => mergeText(b,l,r,(line: number,old: string,a: string,z: string): string =>
    string(decide("text",target + " · 第 " + line + " 行",old,a,z)));
  if ([base,local,remote].every((d: PublicationDocument): boolean => !d.chapters.length)) {
    return {chapters:[],markdown:text("正文",base.markdown,local.markdown,remote.markdown)};
  }
  if ([base,local,remote].some((d: PublicationDocument): boolean => !d.chapters.length)) {
    const [b,l,r] = [base,local,remote].map(body);
    return parsedBody(select(b,l,r,(): JsonValue => decide("chapter","单文件与分章正文",b,l,r)));
  }
  const [b,l,r] = [base,local,remote].map((doc: PublicationDocument): Map<string,Chapter> =>
    new Map(doc.chapters.map((c: Chapter): [string,Chapter] => [c.id,c])));
  const chapters: Chapter[] = [];
  for (const id of chapterOrder([...b.keys()],[...l.keys()],[...r.keys()],decide)) {
    const old = b.get(id) ?? null, left = l.get(id) ?? null, right = r.get(id) ?? null;
    if (old && left && right) {
      const markdown = text("章节 " + id,old.markdown,left.markdown,right.markdown);
      const derived = [old,left,right].every((c: Chapter): boolean => inspectChapter(c.markdown).title === c.title);
      const title = derived ? inspectChapter(markdown).title : string(select(old.title,left.title,right.title,
        (): JsonValue => decide("chapter","章名 " + id,old.title,left.title,right.title)));
      chapters.push({id,title,markdown});
    } else {
      const selected = select(old,left,right,(): JsonValue => decide("chapter","章节 " + id,old,left,right));
      if (selected !== null) {
        const kept = chapter(selected);
        if (kept.id !== id) throw new Error("选择的章节 ID 不符。");
        chapters.push(kept);
      }
    }
  }
  return {chapters,markdown:chapters.map((c: Chapter): string => c.markdown).join("\n\n")};
}

export function mergeDocuments(base: PublicationDocument, local: PublicationDocument, remote: PublicationDocument): MergeResult {
  return resultOf((decide: Decide): PublicationDocument => {
    const result = {...local,...mergeBody(base,local,remote,decide)};
    for (const key of ["title","authors","abstract","primary_category","license","secondary_categories"] as const) {
      const chosen = select(base[key],local[key],remote[key],(): JsonValue => decide("metadata",key,base[key],local[key],remote[key]));
      if (key === "secondary_categories") result[key] = strings(chosen);
      else result[key] = string(chosen);
    }
    result.bibliography = mergeBibliography(base.bibliography,local.bibliography,remote.bibliography,
      (target: string,b: string|null,l: string|null,r: string|null): string|null => {
        const chosen = decide("bibliography",target,b,l,r);
        return chosen === null ? null : string(chosen);
      });
    return result;
  });
}

// With no proven ancestor every differing field/body requires an explicit
// choice. Both complete documents remain available in the comparison.
export function manualMerge(local: PublicationDocument, remote: PublicationDocument): MergeResult {
  return resultOf((decide: Decide): PublicationDocument => {
    const result = {...local};
    for (const key of ["title","authors","abstract","primary_category","license","secondary_categories","bibliography"] as const) {
      if (equal(local[key],remote[key])) continue;
      const picked = decide(key === "bibliography" ? "bibliography" : "metadata",key,null,local[key],remote[key]);
      if (key === "secondary_categories") result[key] = strings(picked);
      else result[key] = string(picked);
    }
    if (!equal(body(local),body(remote))) Object.assign(result,parsedBody(decide("chapter","正文与章节",null,body(local),body(remote))));
    return result;
  });
}

export function resolveMerge(result: MergeResult, choices: Choices): PublicationDocument {
  const build = builders.get(result);
  if (!build) throw new Error("请重新比较。");
  const doc = build((kind: MergeConflict["kind"],target: string): JsonValue => {
    const id = JSON.stringify([kind,target]);
    if (!Object.hasOwn(choices,id)) throw new Error("请先处理全部冲突。");
    return choices[id];
  });
  resolutions.set(doc,result);
  return doc;
}

export function planMergedFiles(project: ProjectSnapshot, merged: PublicationDocument): readonly FileChange[] {
  if (previews.has(merged)) throw new Error("请先处理全部冲突。");
  const local = toPublicationDocument(project);
  const {chapters,markdown,bibliography,...metadata} = merged;
  const config = {...project.config,...metadata};
  if (equal(local.secondary_categories,metadata.secondary_categories)) config.secondary_categories = project.config.secondary_categories;
  const files = new Map(project.files.map((f: SourceFile): [string,SourceFile] => [f.path,f]));
  const changes: FileChange[] = [];
  const update = (path: string, afterText: string): void => {
    const previous = files.get(path);
    if (previous?.text !== afterText) changes.push({path,beforeDigest:previous?.digest ?? null,afterText});
  };
  if (chapters.length || config.chapters) {
    config.chapters = chapters.map((item: Chapter): ChapterSpec => {
      if (inspectChapter(item.markdown).title !== item.title) throw new Error("章节标题与正文标题不一致，请核对：" + item.id);
      const prior = project.config.chapters?.find((c: ChapterSpec): boolean => c.id === item.id);
      const file = prior?.file ?? "chapters/" + item.id + ".md";
      if (!prior && files.has(file)) throw new Error("新章节路径已由其他文件占用：" + file);
      update(file,item.markdown);
      const oldTitle = local.chapters.find((c: Chapter): boolean => c.id === item.id)?.title;
      return {id:item.id,file,title:prior && item.title === oldTitle ? prior.title : item.title};
    });
  }
  if (!chapters.length) update("paper.md",markdown);
  if (bibliography || config.bibliography) {
    config.bibliography ??= "references.yaml";
    update(config.bibliography,bibliography);
  }
  projectMembers(config);
  // A removed member remains on disk. The manifest alone controls membership.
  if (!equal(project.config,config)) update("paper.json",JSON.stringify(config,null,2) + "\n");
  const resolved = resolutions.get(merged);
  const plan = Object.freeze(changes.map((change: FileChange): FileChange => Object.freeze(change)));
  if (resolved) plans.set(plan,{root:project.root,revision:project.revision,result:resolved});
  return plan;
}
