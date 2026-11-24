import { UserFacingError } from "../user-error";
import { exactOrigin } from "./transport";
import type { RemoteTarget } from "./types";

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(value);
}

export function isPublicId(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{6}\.[a-f0-9]{12,64}$/u.test(value)) return false;
  const date = "20" + value.slice(0, 2) + "-" + value.slice(2, 4) + "-" + value.slice(4, 6);
  const instant = new Date(date + "T00:00:00Z");
  return Number.isFinite(instant.valueOf()) && instant.toISOString().startsWith(date + "T");
}

export function parseRemoteLink(input: string, origin: string): RemoteTarget {
  exactOrigin(origin);
  const invalid = new UserFacingError("Enter a paper, snapshot, or version reading link from the selected site.");
  const match = /^https?:\/\/[^/?#]+(\/[^?#]*)/iu.exec(input);
  if (!match || /[\\\x00-\x20\x7f]/u.test(input)) throw invalid;
  let url: URL;
  try { url = new URL(input); } catch { throw invalid; }
  // Compare the original path, before URL's dot-segment or backslash normalization.
  if (url.origin !== origin || url.username || url.password || url.pathname !== match[1]) throw invalid;
  const direct = /^\/(papers|submissions)\/([^/]+)\/(?:read\/)?$/u.exec(url.pathname);
  if (direct && (isUuid(direct[2]) || isPublicId(direct[2]))) {
    return {kind: direct[1] === "papers" ? "paper" : "snapshot", identifier: direct[2]};
  }
  const version = /^\/papers\/([^/]+)\/versions\/([^/]+)\/read\/$/u.exec(url.pathname);
  if (version && isPublicId(version[1]) && isUuid(version[2])) {
    return {kind: "snapshot", identifier: version[2], expectedPaperIdentifier: version[1]};
  }
  throw invalid;
}
