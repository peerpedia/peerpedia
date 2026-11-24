import type { PublicationDocument } from "../src/project/document";

export interface RenderRequest {
  id: string;
  revision: string;
  document: PublicationDocument;
}

export interface SourceTarget {
  id: string;
  chapterId: string;
  /** UTF-16 offsets into the chapter Markdown or the shared bibliography, as specified by source. */
  from: number;
  to: number;
  kind: "heading" | "theorem" | "equation" | "bibliography";
  source: "chapter" | "bibliography";
}

export interface RenderPage {
  id: string;
  title: string;
  html: string;
  targets: readonly SourceTarget[];
}

export interface RenderSuccess {
  id: string;
  revision: string;
  pages: readonly RenderPage[];
}

export interface RenderFailure {
  id: string;
  revision: string;
  error: { message: string; file?: string; line?: number; column?: number };
}

export type RenderResponse = RenderSuccess | RenderFailure;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function failure(request: Pick<RenderRequest, "id" | "revision">, message: string): RenderFailure {
  return { id: request.id, revision: request.revision, error: { message } };
}
