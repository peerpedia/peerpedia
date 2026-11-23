import { defineDialect, type SyntaxNodeRef } from "bananamark";

import { inspectChapter } from "../../../editor/chapter-title.js";
import { dialectOptions } from "../../../editor/dialect.js";
import { CONFIG_PATH, projectMembers } from "./store";
import { ProjectReadError, type ChapterSpec, type PaperConfig, type ProjectIssue, type ProjectSnapshot, type SourceFile } from "./types";

export interface PublicationDocument extends Pick<
  PaperConfig,
  "title" | "authors" | "abstract" | "primary_category" | "secondary_categories" | "license"
> {
  markdown: string;
  chapters: readonly { id: string; title: string; markdown: string }[];
  bibliography: string;
}

const MAX_CHAPTERS = 64;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIAGRAMS = 32;
const MAX_DIAGRAM_BYTES = 32 * 1024;
const parser = defineDialect(dialectOptions).language.language.parser;

function sourceText(files: ReadonlyMap<string, string>, path: string): string {
  const text = files.get(path);
  if (text === undefined) throw new ProjectReadError(path, `Missing project file "${path}".`, "missing");
  return text;
}

function compareCodePoints(left: string, right: string): number {
  // Python's sorted() compares Unicode code points. UTF-8 preserves that order.
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function toPublicationDocument(snapshot: ProjectSnapshot): PublicationDocument {
  const { chapters: specs, bibliography: bibliographyPath, secondary_categories, ...metadata } = snapshot.config;
  const files = new Map(snapshot.files.map((file: SourceFile): readonly [string, string] => [file.path, file.text]));
  for (const path of projectMembers(snapshot.config)) sourceText(files, path);
  const chapters = (specs ?? []).map((chapter: ChapterSpec): PublicationDocument["chapters"][number] => {
    const markdown = sourceText(files, chapter.file);
    return { id: chapter.id, title: inspectChapter(markdown).title, markdown };
  });
  return {
    ...metadata,
    secondary_categories: secondary_categories.slice().sort(compareCodePoints),
    chapters,
    markdown: chapters.length
      ? chapters.map((chapter: PublicationDocument["chapters"][number]): string => chapter.markdown).join("\n\n")
      : sourceText(files, "paper.md"),
    bibliography: bibliographyPath ? sourceText(files, bibliographyPath) : "",
  };
}

function diagramSizes(source: string): readonly number[] {
  if (!source.includes("tikz")) return [];
  const diagrams: number[] = [];
  // The website normalizes CRLF during rendering. Parse the same text here, and
  // leave the original string in the snapshot and publication document.
  const normalized = source.replace(/\r\n?/g, "\n");
  const tikzEnvironment = /\\begin\s*\{\s*(?:tikzcd|tikzpicture)\s*\}/;
  const read = (node: SyntaxNodeRef["node"]): string => normalized.slice(node.from, node.to);
  parser.parse(normalized).iterate({
    enter(ref: SyntaxNodeRef): false | void {
      const node = ref.node;
      const info = node.firstChild?.nextSibling;
      if (ref.name === "FencedCode") {
        const language = info && read(info).trim().split(/[ \t{]/, 1)[0];
        const code = node.getChildren("CodeText").map(read).join("");
        if (language === "tikz" || (language === "math" && tikzEnvironment.test(code))) {
          diagrams.push(Buffer.byteLength(code));
        }
        // A source example may have a complete nested grammar of its own.
        return false;
      }
      if ((ref.name === "DisplayMath" || ref.name === "InlineMath") && info) {
        const tex = read(info);
        if (tikzEnvironment.test(tex)) diagrams.push(Buffer.byteLength(tex.trim()));
        return false;
      }
    },
  });
  return diagrams;
}

export function validateProject(snapshot: ProjectSnapshot): readonly ProjectIssue[] {
  let members: readonly string[];
  try {
    members = projectMembers(snapshot.config);
  } catch (error: unknown) {
    if (error instanceof ProjectReadError) return [error.issue];
    throw error;
  }
  const issues: ProjectIssue[] = [];
  const issue = (path: string, message: string): void => {
    issues.push({ path, message, severity: "error" });
  };
  const files = new Map(snapshot.files.map((file: SourceFile): readonly [string, string] => [file.path, file.text]));
  const count = snapshot.config.chapters?.length ?? 0;
  if (count > MAX_CHAPTERS) issue(CONFIG_PATH, `Use up to ${MAX_CHAPTERS} chapters.`);
  const bibliography = snapshot.config.bibliography;
  let bytes = Math.max(0, count - 1) * 2; // The two newlines between each pair of chapters.
  let totalDiagrams = 0;
  for (const path of members) {
    const source = files.get(path);
    if (source === undefined) {
      issue(path, `Missing project file "${path}".`);
      continue;
    }
    if (path === CONFIG_PATH) continue;
    bytes += Buffer.byteLength(source);
    if (/[\u0000\uD800-\uDFFF]/u.test(source)) {
      issue(path, "Use valid UTF-8 without NUL characters.");
    }
    if (path === bibliography) continue;
    for (const size of diagramSizes(source)) {
      if (++totalDiagrams === MAX_DIAGRAMS + 1) issue(path, `Use up to ${MAX_DIAGRAMS} diagrams.`);
      if (size > MAX_DIAGRAM_BYTES) issue(path, "Keep each diagram at or below 32 KiB.");
    }
  }
  if (bytes > MAX_TEXT_BYTES) issue(CONFIG_PATH, "The complete paper and bibliography must fit in 1 MiB.");
  return issues;
}
