import { UserFacingError } from "../user-error";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { toPublicationDocument, type PublicationDocument } from "../project/publication";
import { sourceDigest } from "../project/store";
import type { ProjectSnapshot } from "../project/types";
import { isUuid } from "./links";
import { exactOrigin } from "./transport";
import type { AccountInfo, RemoteBinding, VerifiedSnapshot } from "./types";
import { array, checksum, nonempty, object, ProtocolError, text, verifySnapshot } from "./verify";

export type SubmissionIntent = "publish"|"append-pr"|"new-pr";
export interface SubmissionDetails { explanation:string; aiAssisted:boolean }
export interface PreparedSubmission {
  id:string; origin:string; username:string; intent:SubmissionIntent; sourceRevision:string; payloadJson:string; payloadDigest:string;
}
interface Payload extends PublicationDocument {
  paper_id:string|null; base_hash:string|null; explanation:string; ai_assisted:boolean; pull_request_id?:string; expected_head?:string;
}
export function defaultIntent(binding: RemoteBinding|null, username: string): SubmissionIntent {
  if (!binding) return "publish";
  return binding.activePr?.status === "pending" && binding.activePr.owner === username ? "append-pr" : "new-pr";
}

export function checkAccount(account: AccountInfo, username: string, intent: SubmissionIntent): void {
  if (account.username !== username) throw new UserFacingError("The token belongs to a different account. Connect the account that prepared this submission.");
  if (!account.scopes.includes(intent === "publish" ? "publish" : "propose")) throw new UserFacingError("The token lacks the required submission scope.");
  if (Date.parse(account.expiresAt) <= Date.now()) throw new UserFacingError("The token has expired. Reconnect your account.");
  if (!account.agreement.accepted) throw new UserFacingError("Read and accept the publishing agreement on the website.");
}

// Django CharField uses Python str.strip(), including U+001C–U+001F and U+0085.
function formText(value: string): string {
  return value.replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu,"");
}

function shortText(raw: unknown, max: number): string {
  const value = nonempty(raw);
  if (value !== formText(value) || Array.from(value).length > max || value.includes("\0")) throw new UserFacingError("Check the length and formatting of the title, authors, abstract and submission explanation.");
  return value;
}

export function publication(project: ProjectSnapshot): PublicationDocument {
  const doc = toPublicationDocument(project);
  return {...doc,title:formText(doc.title),authors:formText(doc.authors),abstract:formText(doc.abstract)};
}

export function frozenPayload(request: PreparedSubmission): Payload {
  const row = object(JSON.parse(request.payloadJson));
  const chapters = array(row.chapters).map((raw: unknown): PublicationDocument["chapters"][number] => {
    const ch = object(raw);
    if (typeof ch.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(ch.id) || !text(ch.markdown).trim()) throw new ProtocolError();
    return {id:ch.id,title:text(ch.title),markdown:text(ch.markdown)};
  });
  const markdown = nonempty(row.markdown), bibliography = text(row.bibliography);
  if (chapters.length > 64 || new Set(chapters.map((c: PublicationDocument["chapters"][number]): string => c.id.toLowerCase())).size !== chapters.length
    || !markdown.trim() || (markdown+bibliography).includes("\0") || Buffer.byteLength(markdown+bibliography) > 1024*1024
    || (chapters.length && chapters.map((c: PublicationDocument["chapters"][number]): string => c.markdown).join("\n\n") !== markdown)) throw new ProtocolError();
  const initial = request.intent === "publish";
  if (initial ? row.paper_id !== null || row.base_hash !== null : !isUuid(row.paper_id)) throw new ProtocolError();
  if (typeof row.ai_assisted !== "boolean") throw new ProtocolError();
  const payload: Payload = {paper_id:initial ? null : nonempty(row.paper_id),base_hash:initial ? null : checksum(row.base_hash),
    title:shortText(row.title,250),authors:shortText(row.authors,2000),abstract:shortText(row.abstract,10000),
    explanation:shortText(row.explanation,5000),primary_category:nonempty(row.primary_category),secondary_categories:array(row.secondary_categories).map(nonempty),
    license:nonempty(row.license),ai_assisted:row.ai_assisted,markdown,chapters,bibliography};
  if (request.intent === "append-pr") {
    if (!isUuid(row.pull_request_id)) throw new ProtocolError();
    payload.pull_request_id = row.pull_request_id;
    payload.expected_head = checksum(row.expected_head);
  }
  if (!equal(payload,row)) throw new ProtocolError();
  return payload;
}

export function decodeRequest(value: unknown): PreparedSubmission {
  const row = object(value);
  if (!isUuid(row.id) || (row.intent !== "publish" && row.intent !== "append-pr" && row.intent !== "new-pr")) throw new ProtocolError();
  const request: PreparedSubmission = {id:row.id,origin:exactOrigin(nonempty(row.origin)).origin,username:nonempty(row.username),intent:row.intent,
    sourceRevision:checksum(row.sourceRevision),payloadJson:nonempty(row.payloadJson),payloadDigest:checksum(row.payloadDigest)};
  if (sourceDigest(Buffer.from(request.payloadJson)) !== request.payloadDigest || !equal(request,row)) throw new ProtocolError();
  frozenPayload(request);
  return Object.freeze(request);
}

export function prepareSubmission(project: ProjectSnapshot, binding: RemoteBinding|null, account: AccountInfo, intent: SubmissionIntent,
  details: SubmissionDetails, selectedOrigin?: string): PreparedSubmission {
  const agreementOrigin = new URL(account.agreement.url).origin;
  const origin = exactOrigin(selectedOrigin ?? agreementOrigin).origin;
  if (origin !== agreementOrigin || (binding && binding.origin !== origin)) throw new UserFacingError("The selected site differs from the account or paper binding.");
  checkAccount(account,account.username,intent);
  const initial = intent === "publish";
  if (initial !== !binding || (intent === "append-pr" && defaultIntent(binding,account.username) !== intent)) throw new UserFacingError("The paper or proposal is unavailable for this submission.");
  const doc = publication(project);
  if (binding && binding.acceptedBase.document.license && binding.acceptedBase.document.license !== doc.license) throw new UserFacingError("A proposal must use the paper’s existing license.");
  const payloadJson = JSON.stringify({...doc,paper_id:binding?.paperId ?? null,base_hash:binding?.acceptedBase.hash ?? null,
    explanation:formText(details.explanation) || (initial ? "Initial publication." : ""),ai_assisted:details.aiAssisted,
    ...(intent === "append-pr" ? {pull_request_id:binding!.activePr!.id,expected_head:binding!.activePr!.hash} : {})});
  return decodeRequest({id:randomUUID(),origin,username:account.username,intent,sourceRevision:project.revision,payloadJson,
    payloadDigest:sourceDigest(Buffer.from(payloadJson))});
}

export interface PushReceipt {snapshot:VerifiedSnapshot; proposal:{id:string;number:number}|null}

export interface AppendHead {id:string; submissionId:string; hash:string; number:number}
export function verifyReceipt(request: PreparedSubmission, raw: unknown, head?: AppendHead|null): PushReceipt {
  const row = object(raw), snapshot = verifySnapshot(row);
  const {paper_id,base_hash,explanation,ai_assisted,pull_request_id,expected_head,...doc} = frozenPayload(request);
  if (!equal(doc,snapshot.document) || row.ai_assisted !== ai_assisted || snapshot.manifest.contributor_name !== request.username
    || snapshot.manifest.explanation !== explanation || snapshot.manifest.base_hash !== base_hash
    || (paper_id && snapshot.paperId !== paper_id)) throw new ProtocolError();
  if (request.intent === "publish") {
    if (row.pull_request !== null || snapshot.status !== "accepted") throw new ProtocolError();
    return {snapshot,proposal:null};
  }
  const pr = object(row.pull_request);
  if (!isUuid(pr.id) || typeof pr.snapshot !== "number" || !Number.isSafeInteger(pr.snapshot)
    || (pull_request_id ? !head || head.id !== pull_request_id || head.hash !== expected_head || !isUuid(head.submissionId)
      || !Number.isSafeInteger(head.number) || head.number < 1 || pr.id !== head.id || pr.snapshot !== head.number+1
      || snapshot.submissionId === head.submissionId || snapshot.hash === expected_head : pr.snapshot !== 1)) throw new ProtocolError();
  return {snapshot,proposal:{id:pr.id,number:pr.snapshot}};
}
