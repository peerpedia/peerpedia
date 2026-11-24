import { UserFacingError } from "../user-error";
import { createHash } from "node:crypto";
import type { PublicationDocument } from "../project/publication";
import { isPublicId, isUuid } from "./links";
import type { JsonValue, VerifiedSnapshot } from "./types";

export class ProtocolError extends UserFacingError {
  constructor() { super("The site returned invalid or unverifiable version data."); }
}

export function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new ProtocolError();
  return value as Record<string, unknown>;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolError();
  return value;
}

export function text(value: unknown): string {
  // TextEncoder replaces lone UTF-16 surrogates. Python's strict UTF-8 encoder rejects them.
  if (typeof value !== "string" || /[\ud800-\udfff]/u.test(value)) throw new ProtocolError();
  return value;
}

export function nonempty(value: unknown): string {
  const result = text(value);
  if (!result.length) throw new ProtocolError();
  return result;
}

export function checksum(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new ProtocolError();
  return value;
}

export function readStatus(value: unknown): VerifiedSnapshot["status"] {
  if (value === "pending" || value === "accepted" || value === "rejected" || value === "withdrawn" || value === "superseded") return value;
  throw new ProtocolError();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// UTF-8 byte order equals scalar-value order, including for astral keys.
// Serialize directly: JSON.stringify(object) would reorder integer-like keys.
function compareKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(text(value));
  if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
  if (typeof value !== "object" || ancestors.has(value) || Object.getOwnPropertySymbols(value).length) throw new ProtocolError();
  ancestors.add(value);
  let result: string;
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new ProtocolError();
    result = "[" + Array.from(value, (item: unknown): string => canonical(item, ancestors)).join(",") + "]";
  } else {
    const fields = object(value);
    const pairs = Object.keys(fields).sort(compareKeys).map((key: string): string =>
      JSON.stringify(text(key)) + ":" + canonical(fields[key], ancestors));
    result = "{" + pairs.join(",") + "}";
  }
  ancestors.delete(value);
  return result;
}

function utcDate(value: unknown): string {
  const submitted = text(value);
  // Django emits timezone-aware ISO timestamps. Date.parse alone rolls over invalid days.
  const match = /^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(submitted);
  if (!match) throw new ProtocolError();
  const calendar = new Date(match[1] + "T00:00:00Z");
  const utc = new Date(submitted);
  if (!Number.isFinite(utc.valueOf()) || !Number.isFinite(calendar.valueOf())
    || calendar.toISOString().slice(0, 10) !== match[1]) throw new ProtocolError();
  return utc.toISOString().slice(2, 10).replaceAll("-", "");
}

function readChapters(record: Record<string, unknown>, manifest: Record<string, unknown>, markdown: string): PublicationDocument["chapters"] {
  const source = array(record.chapters);
  const checks = array(manifest.chapters);
  if (source.length > 64 || source.length !== checks.length) throw new ProtocolError();
  const seen = new Set<string>();
  const chapters = source.map((raw: unknown, index: number): PublicationDocument["chapters"][number] => {
    const page = object(raw);
    const check = object(checks[index]);
    const id = text(page.id);
    const title = text(page.title);
    const body = text(page.markdown);
    if (Object.keys(page).length !== 3 || Object.keys(check).length !== 3 || !/^[A-Za-z0-9_-]{1,64}$/u.test(id)
      || seen.has(id.toLowerCase()) || check.id !== id || check.title !== title || check.markdown_sha256 !== sha256(body)) throw new ProtocolError();
    seen.add(id.toLowerCase());
    return {id, title, markdown: body};
  });
  if (chapters.length && chapters.map((page: PublicationDocument["chapters"][number]): string => page.markdown).join("\n\n") !== markdown)
    throw new ProtocolError();
  return chapters;
}

export function verifySnapshot(raw: unknown): VerifiedSnapshot {
  const record = object(raw);
  const input = object(record.manifest);
  let serialized: string;
  try { serialized = canonical(input, new Set()); } catch { throw new ProtocolError(); }
  const hash = checksum(record.hash);
  if (sha256(serialized) !== hash) throw new ProtocolError();
  // The returned document and manifest cannot acquire changes through the untrusted input.
  const manifest: Record<string, JsonValue> = JSON.parse(serialized);
  const format = /^peerpedia-submission-v([1-4])$/u.exec(text(manifest.format));
  const paperId = manifest.paper_id;
  const submissionId = manifest.submission_id;
  if (!format || !isUuid(paperId) || !isUuid(submissionId) || !Number.isSafeInteger(manifest.contributor_id)) throw new ProtocolError();
  text(manifest.contributor_name);
  text(manifest.explanation);
  if (manifest.base_hash !== null) checksum(manifest.base_hash);
  const date = utcDate(manifest.submitted_at);
  const publicId = record.snapshot_identifier ?? null;
  if (publicId !== null && (!isPublicId(publicId) || !publicId.startsWith(date + ".") || !hash.startsWith(publicId.slice(7)))) throw new ProtocolError();
  const markdown = text(record.markdown);
  if (sha256(markdown) !== manifest.markdown_sha256) throw new ProtocolError();
  const version = Number(format[1]);
  const document: PublicationDocument = {
    title: text(manifest.title), authors: text(manifest.authors), abstract: text(manifest.abstract), markdown,
    primary_category: version >= 2 ? nonempty(manifest.primary_category) : "",
    secondary_categories: version >= 2 ? array(manifest.secondary_categories).map(text) : [],
    license: version >= 3 ? nonempty(manifest.license) : "", chapters: [], bibliography: "",
  };
  if (version >= 3) {
    const agreement = object(manifest.agreement);
    nonempty(agreement.version);
    checksum(agreement.sha256);
    utcDate(agreement.accepted_at);
    if (!Number.isSafeInteger(agreement.acceptance_id)) throw new ProtocolError();
  }
  if (version === 4) {
    document.chapters = readChapters(record, manifest, markdown);
    document.bibliography = text(record.bibliography);
    if (sha256(document.bibliography) !== manifest.bibliography_sha256) throw new ProtocolError();
  } else if ((record.chapters !== undefined && array(record.chapters).length > 0)
    || (record.bibliography !== undefined && record.bibliography !== "")) {
    throw new ProtocolError();
  }
  return {paperId, submissionId, publicId, hash, status: readStatus(record.status), document, manifest};
}
