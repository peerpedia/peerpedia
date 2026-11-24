import { pathKey, vaultPath } from "../project/path-identity";
import type { RenderPage, RenderSuccess, SourceTarget } from "../../renderer/protocol";
import type { ChapterSpec, ProjectSnapshot, SourceFile } from "../project/types";

export function previewMember(project: ProjectSnapshot, path: string): SourceFile | undefined {
  const key = pathKey(path);
  return project.files.find((file: SourceFile): boolean => pathKey(vaultPath(project.root, file.path)) === key);
}

export interface ReaderLocation { target: SourceTarget | null; exact: boolean }

export function viewportTarget(
  targets: readonly SourceTarget[], bounds: (id: string) => Pick<DOMRect, "top" | "bottom"> | null,
): ReaderLocation {
  let nearest: SourceTarget | null = null;
  let distance = Infinity;
  const readingLine = 12;
  for (const target of targets) {
    const rect = bounds(target.id);
    if (!rect || rect.bottom <= rect.top) continue;
    const gap = Math.max(rect.top - readingLine, readingLine - rect.bottom, 0);
    if (gap < distance) { nearest = target; distance = gap; }
  }
  return {target: nearest, exact: distance === 0};
}

export function chapterPath(id: string, project: ProjectSnapshot): string | null {
  const chapters = project.config.chapters;
  if (!chapters?.length) return id === "main" ? "paper.md" : null;
  return chapters.find((chapter: ChapterSpec): boolean => chapter.id === id)?.file ?? null;
}

export function targetPath(target: SourceTarget, project: ProjectSnapshot): string | null {
  return target.source === "bibliography" ? project.config.bibliography ?? null : chapterPath(target.chapterId, project);
}

/** Map a native LF offset back into a raw mixed-newline snapshot. Build once per displayed source. */
export function rawCoordinates(source: string): (offset: number) => number {
  const breaks: number[] = [];
  for (let index = source.indexOf("\r\n"); index >= 0; index = source.indexOf("\r\n", index + 2)) {
    breaks.push(index - breaks.length);
  }
  return (offset: number): number => {
    let low = 0;
    let high = breaks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (breaks[mid] < offset) low = mid + 1;
      else high = mid;
    }
    return offset + low;
  };
}

export function locatePreview(path: string, offset: number, result: RenderSuccess, project: ProjectSnapshot): SourceTarget | null {
  if (result.revision !== project.revision) return null;
  let nearest: SourceTarget | null = null;
  let distance = Infinity;
  for (const page of result.pages) {
    if (path !== project.config.bibliography && chapterPath(page.id, project) !== path) continue;
    for (const target of page.targets) {
      if (targetPath(target, project) !== path) continue;
      const gap = Math.max(target.from - offset, offset - target.to, 0);
      if (gap < distance) { nearest = target; distance = gap; }
    }
  }
  return nearest;
}

export function pageForSource(path: string, result: RenderSuccess, project: ProjectSnapshot): RenderPage | undefined {
  return path === project.config.bibliography ? result.pages.at(-1)
    : result.pages.find((page: RenderPage): boolean => chapterPath(page.id, project) === path);
}

export function bindSourceButton(button: EventTarget, open: () => void): void {
  button.addEventListener("click", open);
}
