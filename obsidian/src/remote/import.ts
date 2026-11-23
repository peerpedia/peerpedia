import { CONFIG_PATH, projectMembers, projectRevision, sourceDigest, type FileChange, type ProjectStore } from "../project/store";
import type { ChapterSpec, PaperConfig, ProjectSnapshot, SourceFile } from "../project/types";
import type { PublicationDocument } from "../project/publication";
import type { PeerpediaApi } from "./api";
import type { RemoteBinding, RemoteTarget, VerifiedSnapshot } from "./types";

export function importChanges(snapshot: VerifiedSnapshot): FileChange[] {
  const {chapters, markdown, bibliography, ...metadata} = snapshot.document;
  const config: PaperConfig = {...metadata};
  const changes: FileChange[] = [];
  if (snapshot.manifest.format === "peerpedia-submission-v4") {
    config.chapters = chapters.map((chapter: PublicationDocument["chapters"][number]): ChapterSpec => {
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(chapter.id)) throw new Error("章节 ID 无效。");
      const file = "chapters/" + chapter.id + ".md";
      changes.push({path:file,beforeDigest:null,afterText:chapter.markdown});
      return {id:chapter.id,title:chapter.title,file};
    });
    config.bibliography = "references.yaml";
    changes.push({path:config.bibliography,beforeDigest:null,afterText:bibliography});
  }
  projectMembers(config);
  if (!chapters.length) changes.push({path:"paper.md",beforeDigest:null,afterText:markdown});
  changes.push({path:CONFIG_PATH,beforeDigest:null,afterText:JSON.stringify(config,null,2) + "\n"});
  return changes;
}

export function importedRevision(snapshot: VerifiedSnapshot): string {
  return projectRevision(importChanges(snapshot).map((change: FileChange): SourceFile => ({
    path:change.path,text:change.afterText!,digest:sourceDigest(Buffer.from(change.afterText!)),
  })));
}

export interface ImportStore extends ProjectStore {
  loadBinding(root: string): Promise<RemoteBinding | null>;
}

export async function importPaper(target: RemoteTarget, root: string, api: PeerpediaApi, store: ImportStore,
  current: () => boolean = (): boolean => true, onCommit?: () => void): Promise<ProjectSnapshot> {
  const live = (): void => { if (!current()) throw new Error("已取消导入。"); };
  live();
  const working = target.kind === "paper" ? await api.current(target.identifier) : await api.snapshot(target.identifier);
  live();
  const accepted = target.kind === "paper" ? working : await api.current(target.expectedPaperIdentifier ?? working.paperId);
  if (accepted.paperId !== working.paperId || accepted.status !== "accepted") throw new Error("版本链接所指的论文与快照不一致。");
  const changes = importChanges(working);
  const binding: RemoteBinding = {schemaVersion:1,origin:api.origin,paperId:working.paperId,acceptedBase:accepted,
    workingBase:working,lastSubmitted:null,activePr:null,checkedAt:new Date().toISOString()};
  live();
  onCommit?.();
  const project = await store.create(root,changes,binding);
  const saved = await store.loadBinding(root);
  if (saved?.origin !== binding.origin || saved.workingBase.hash !== working.hash || saved.acceptedBase.hash !== accepted.hash) {
    throw new Error("无法确认导入绑定，请打开论文面板核对。");
  }
  return project;
}
