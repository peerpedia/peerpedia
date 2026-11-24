import { importChanges } from "../../src/remote/import";
import { projectRevision, sourceDigest, type FileChange, parsePaperConfig } from "../../src/project/store";
import type { SourceFile, ProjectSnapshot } from "../../src/project/types";
import { verifySnapshot } from "../../src/remote/verify";
import type { AccountInfo, RemoteBinding } from "../../src/remote/types";
import raw from "./manifests/v4.json";
export const origin = "https://custom.invalid", root = "book";
export const details = {explanation:"历史版本",aiAssisted:false};
export const snapshot = verifySnapshot(raw);
export const account: AccountInfo = {username:"fixture-author",agreement:{url:origin+"/agreement/",accepted:true,version:"1"},
  expiresAt:"2099-01-01T00:00:00Z",scopes:["publish","propose"]};
export const binding: RemoteBinding = {schemaVersion:1,paperId:snapshot.paperId,origin,acceptedBase:snapshot,workingBase:snapshot,lastSubmitted:null,
  checkedAt:"2026-01-01T00:00:00.000Z",activePr:{id:"00000000-0000-0000-0000-0000000000ac",status:"pending",owner:account.username,
    hash:snapshot.hash,submissionId:snapshot.submissionId}};
const files = importChanges(snapshot).map((c: FileChange): SourceFile =>
  ({path:c.path,text:c.afterText!,digest:sourceDigest(Buffer.from(c.afterText!))}));
export const project: ProjectSnapshot = {root,files,revision:projectRevision(files),config:parsePaperConfig(files.find((f: SourceFile): boolean => f.path==="paper.json")!.text)};

export type Receipt = Omit<typeof raw,"pull_request"|"manifest"> & {
  pull_request:{id:string;snapshot:number}|null; manifest:Omit<typeof raw.manifest,"base_hash"> & {base_hash:string|null};
};
export function rehash(row:Receipt): Receipt {
  const keys = new Set<string>();
  JSON.stringify(row.manifest,(key:string,value:unknown):unknown => { keys.add(key); return value; });
  row.hash = sourceDigest(Buffer.from(JSON.stringify(row.manifest,[...keys].sort())));
  row.snapshot_identifier = "240229."+row.hash.slice(0,12);
  return row;
}
export function receipt(base:string|null,prId?:string,ordinal:number=1):Receipt {
  const row:Receipt = structuredClone(raw);
  row.manifest.base_hash = base;
  row.status = prId ? "pending" : "accepted";
  row.pull_request = prId ? {id:prId,snapshot:ordinal} : null;
  row.manifest.submission_id = "00000000-0000-0000-0000-0000000000ff";
  return rehash(row);
}
