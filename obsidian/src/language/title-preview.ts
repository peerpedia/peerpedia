import { defineDialect, type SyntaxNodeRef } from "bananamark";
import { inspectChapter } from "../../../editor/chapter-title.js";
import { dialectOptions } from "../../../editor/dialect.js";

const parser = defineDialect(dialectOptions).language.language.parser;
export interface TitlePreview { text: string; title: string; before: string; after: string }

/** Match the website's first top-level H1 (or first heading), including setext. */
function titleRange(source: string): { from: number; to: number } | undefined {
  let depth = 0;
  let first: { from: number; to: number } | undefined;
  let h1: { from: number; to: number } | undefined;
  parser.parse(source).iterate({
    enter(node: SyntaxNodeRef): void {
      if (node.name === "EnvironmentFence") depth += /^\s*:::\s*$/.test(source.slice(node.from, node.to)) ? -1 : 1;
      if (depth || node.node.parent?.name !== "Document" || node.node.parent.parent || !/^(ATX|Setext)Heading\d$/.test(node.name)) return;
      const range = { from: node.from, to: source[node.to - 1] === "\r" ? node.to - 1 : node.to };
      first ??= range;
      if (node.name.endsWith("1")) h1 ??= range;
    }
  });
  return h1 ?? first;
}

export function previewTitle(source: string, title: string): TitlePreview {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error("请输入单行章名。");
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = source.slice(bom.length);
  const range = titleRange(body);
  const eol = body.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const oldHeading = range ? body.slice(range.from, range.to) : "";
  const label = oldHeading.split(/\r\n?|\n/)[0].match(/\s+\{@[^{}\s]+\}(?=\s*#*\s*$)/)?.[0] ?? "";
  const heading = "# " + title.trim() + label;
  const text = bom + (range ? body.slice(0, range.from) + heading + body.slice(range.to) : heading + eol + eol + body);
  const actual = inspectChapter(text).title;
  return { text, title: actual, before: oldHeading, after: heading };
}
