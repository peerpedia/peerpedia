import { inspectChapter } from "../../../editor/chapter-title.js";
import { projectMembers } from "./members";
import { ProjectReadError, type ChapterSpec, type PaperConfig, type ProjectSnapshot, type SourceFile } from "./types";

export interface PublicationDocument extends Pick<
  PaperConfig,
  "title" | "authors" | "abstract" | "primary_category" | "secondary_categories" | "license"
> {
  markdown: string;
  chapters: readonly { id: string; title: string; markdown: string }[];
  bibliography: string;
}

function sourceText(files: ReadonlyMap<string, string>, path: string): string {
  const text = files.get(path);
  if (text === undefined) throw new ProjectReadError(path, `Missing project file "${path}".`, "missing");
  return text;
}

function compareCodePoints(left: string, right: string): number {
  // Python's sorted() compares Unicode code points, including astral characters.
  const a = Array.from(left);
  const b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i].codePointAt(0)! - b[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
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
