import { randomUUID } from "node:crypto";
import type { TitlePreview } from "../language/title-preview";
import { CONFIG_PATH, type FileChange } from "./store";
import type { ChapterSpec, PaperConfig, ProjectSnapshot, SourceFile } from "./types";

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

export function chapterTitleEdit(project: ProjectSnapshot, chapter: ChapterSpec, preview: TitlePreview): FileChange[] {
  const source = project.files.find((file: SourceFile): boolean => file.path === chapter.file);
  if (!source) throw new Error("章节原文件不存在。");
  const chapters = project.config.chapters!.map((item: ChapterSpec): ChapterSpec =>
    item.id === chapter.id ? { ...item, title: preview.title } : item);
  return [{ path: chapter.file, beforeDigest: source.digest, afterText: preview.text }, changeMembership(project, chapters)];
}
