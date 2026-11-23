import { randomUUID } from "node:crypto";
import { defineDialect, type SyntaxNodeRef } from "bananamark";
import { inspectChapter } from "../../../editor/chapter-title.js";
import { dialectOptions } from "../../../editor/dialect.js";
import { CONFIG_PATH, type FileChange } from "./store";
import type { ChapterSpec, PaperConfig, ProjectSnapshot, SourceFile } from "./types";

const parser = defineDialect(dialectOptions).language.language.parser;
export function configChange(project: ProjectSnapshot, config: PaperConfig): FileChange {
  const current = project.files.find((file: SourceFile): boolean => file.path === CONFIG_PATH)!;
  return { path: CONFIG_PATH, beforeDigest: current.digest, afterText: JSON.stringify(config, null, 2) + "\n" };
}

export function newPaper(title: string, chaptered: boolean): FileChange[] {
  const config: PaperConfig = { title, authors: "", abstract: "", primary_category: "", secondary_categories: [], license: "" };
  const file = chaptered ? "chapters/intro.md" : "paper.md";
  if (chaptered) config.chapters = [{ id: randomUUID(), title: "引言", file }];
  return [
    { path: CONFIG_PATH, beforeDigest: null, afterText: JSON.stringify(config, null, 2) + "\n" },
    { path: file, beforeDigest: null, afterText: chaptered ? "# 引言\n" : "" },
  ];
}

export function changeMembership(project: ProjectSnapshot, chapters: ChapterSpec[]): FileChange {
  return configChange(project, { ...project.config, chapters });
}

export function reorderChapter(project: ProjectSnapshot, id: string, position: number): FileChange {
  const chapters = [...project.config.chapters ?? []];
  const index = chapters.findIndex((item: ChapterSpec): boolean => item.id === id);
  if (index < 0 || position < 0 || position >= chapters.length) throw new Error("章节顺序已更改。");
  chapters.splice(position, 0, ...chapters.splice(index, 1));
  return changeMembership(project, chapters);
}

/** Match the website's first top-level H1 (or first heading), including setext. */
function titleRange(source: string): { from: number; to: number } | undefined {
  let depth = 0;
  let first: {from: number; to: number} | undefined;
  let h1: {from: number; to: number} | undefined;
  parser.parse(source).iterate({ enter(node: SyntaxNodeRef): void {
    if (node.name === "EnvironmentFence") depth += /^\s*:::\s*$/.test(source.slice(node.from, node.to)) ? -1 : 1;
    if (depth || node.node.parent?.name !== "Document" || node.node.parent.parent || !/^(ATX|Setext)Heading\d$/.test(node.name)) return;
    const range = { from: node.from, to: source[node.to - 1] === "\r" ? node.to - 1 : node.to };
    first ??= range;
    if (node.name.endsWith("1")) h1 ??= range;
  } });
  return h1 ?? first;
}

export function chapterTitleEdit(project: ProjectSnapshot, chapter: ChapterSpec, title: string): FileChange[] {
  if (!title.trim() || /[\r\n]/.test(title)) throw new Error("请输入单行章名。");
  const source = project.files.find((file: SourceFile): boolean => file.path === chapter.file);
  if (!source) throw new Error("章节原文件不存在。");
  const bom = source.text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = source.text.slice(bom.length);
  const range = titleRange(body);
  const eol = body.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const oldHeading = range ? body.slice(range.from, range.to) : "";
  const label = oldHeading.split(/\r\n?|\n/)[0].match(/\s+\{@[^{}\s]+\}(?=\s*#*\s*$)/)?.[0] ?? "";
  const heading = "# " + title.trim() + label;
  const text = bom + (range ? body.slice(0, range.from) + heading + body.slice(range.to) : heading + eol + eol + body);
  const actual = inspectChapter(text).title;
  const chapters = project.config.chapters!.map((item: ChapterSpec): ChapterSpec =>
    item.id === chapter.id ? { ...item, title: actual } : item);
  return [{ path: chapter.file, beforeDigest: source.digest, afterText: text }, changeMembership(project, chapters)];
}
