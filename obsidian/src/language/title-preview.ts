import { defineDialect, type SyntaxNodeRef } from "bananamark";
import type { SyntaxNode } from "@lezer/common";
import { inspectChapter } from "../../../editor/chapter-title.js";
import { dialectOptions } from "../../../editor/dialect.js";

const parser = defineDialect(dialectOptions).language.language.parser;
export interface TitlePreview { text: string; title: string; before: string; after: string }

/** Match the website's first top-level H1 (or first heading), including setext. */
function titleHeading(source: string): SyntaxNode | undefined {
  let depth = 0;
  let first: SyntaxNode | undefined;
  let h1: SyntaxNode | undefined;
  parser.parse(source).iterate({
    enter(node: SyntaxNodeRef): void {
      if (node.name === "EnvironmentFence") depth += /^\s*:::\s*$/.test(source.slice(node.from, node.to)) ? -1 : 1;
      if (depth || node.node.parent?.name !== "Document" || node.node.parent.parent || !/^(ATX|Setext)Heading\d$/.test(node.name)) return;
      first ??= node.node;
      if (node.name.endsWith("1")) h1 ??= node.node;
    }
  });
  return h1 ?? first;
}

export function previewTitle(source: string, title: string): TitlePreview {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error("请输入单行章名。");
  const bom = source.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = source.slice(bom.length);
  const node = titleHeading(body);
  const eol = body.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const end = node ? node.to - Number(body[node.to - 1] === "\r") : 0;
  const oldHeading = node ? body.slice(node.from, end) : "";
  let heading = "# " + title.trim();
  if (node) {
    const atx = node.name.startsWith("ATX");
    const prefix = atx ? body.slice(node.from, end).match(/^#{1,6}[ \t]*/)?.[0] ?? "" : "";
    const suffix = node.lastChild?.name === "HeaderMark" && (!atx || node.lastChild.from !== node.from)
      ? node.lastChild.from : end;
    let visible = body.slice(node.from + prefix.length, suffix).trimEnd();
    // BananaMark accepts the unnumbered star on either side of the attribute block.
    const stripStar = (): void => {
      if (!visible.endsWith("*")) return;
      const last = node.resolveInner(node.from + prefix.length + visible.length, -1).name;
      if (last !== "Escape" && last !== "EmphasisMark") visible = visible.slice(0, -1).trimEnd();
    };
    stripStar();
    visible = visible.replace(/\s*\{[^{}\n]*\}$/, "").trimEnd();
    stripStar();
    const separator = atx && !/[ \t]$/.test(prefix) ? " " : "";
    heading = prefix + separator + title.trim() + oldHeading.slice(prefix.length + visible.length);
  }
  const text = bom + (node ? body.slice(0, node.from) + heading + body.slice(end) : heading + eol + eol + body);
  const actual = inspectChapter(text).title;
  return { text, title: actual, before: oldHeading, after: heading };
}
