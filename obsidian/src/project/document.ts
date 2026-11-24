import { BananamarkError, defineDialect, transformFragment, type SyntaxNodeRef } from "bananamark";

import { dialectOptions } from "../../../editor/dialect.js";
import { CONFIG_PATH, projectMembers } from "./store";
import { ProjectReadError, type ProjectIssue, type ProjectSnapshot, type SourceFile } from "./types";

export { toPublicationDocument, type PublicationDocument } from "./publication";

const MAX_CHAPTERS = 64;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_DIAGRAMS = 32;
const MAX_DIAGRAM_BYTES = 32 * 1024;
const TIKZ_ENVIRONMENT = /\\begin\s*\{\s*(?:tikzcd|tikzpicture)\s*\}/;
const dialect = defineDialect(dialectOptions);
const parser = dialect.language.language.parser;

function collectCaptionDiagrams(opening: string, sizes: number[]): void {
  if (!opening.includes("caption=")) return;
  try {
    // BananaMark's fragment transform runs the website's caption extraction
    // on the opening fence and protects literal examples in its inline code.
    const { nodes } = transformFragment(opening, { dialect });
    if (!nodes.some((node: { type: string }): boolean => node.type === "caption")) return;
    for (const node of nodes) {
      if (node.type === "math" && node.tex !== undefined && TIKZ_ENVIRONMENT.test(node.tex)) {
        sizes.push(Buffer.byteLength(node.tex));
      }
    }
  } catch (error: unknown) {
    // An invalid caption can still be edited, and the rest of the draft remains checkable.
    if (!(error instanceof BananamarkError)) throw error;
  }
}

function diagramSizes(source: string): readonly number[] {
  if (!source.includes("tikz")) return [];
  const diagrams: number[] = [];
  // The website normalizes CRLF during rendering. Parse the same text here, and
  // leave the original string in the snapshot and publication document.
  const normalized = source.replace(/\r\n?/g, "\n");
  const read = (node: SyntaxNodeRef["node"]): string => normalized.slice(node.from, node.to);
  parser.parse(normalized).iterate({
    enter(ref: SyntaxNodeRef): false | void {
      const node = ref.node;
      const info = node.firstChild?.nextSibling;
      if (ref.name === "FencedCode") {
        const language = info && read(info).trim().split(/[ \t{]/, 1)[0];
        const code = node.getChildren("CodeText").map(read).join("");
        if (language === "tikz" || (language === "math" && TIKZ_ENVIRONMENT.test(code))) {
          diagrams.push(Buffer.byteLength(code));
        }
        if (language === "tikz" && info) {
          collectCaptionDiagrams(normalized.slice(node.from, info.to), diagrams);
        }
        // A source example may have a complete nested grammar of its own.
        return false;
      }
      if ((ref.name === "DisplayMath" || ref.name === "InlineMath") && info) {
        const tex = read(info);
        if (TIKZ_ENVIRONMENT.test(tex)) diagrams.push(Buffer.byteLength(tex.trim()));
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
