import type { ProjectAnalysis } from "./analysis";
import { isValidLabel, scanChapter, type LabelTarget, type Reference } from "./index";

export function findTarget(key: string, analysis: ProjectAnalysis): LabelTarget | null {
  const normalized = key.normalize("NFC");
  if (!isValidLabel(normalized)) return null;
  let target: LabelTarget | null = null;
  for (const label of analysis.labels) {
    if (label.key !== normalized) continue;
    if (target) return null;
    target = label;
  }
  return target;
}

export function referenceAt(source: string, offset: number): Reference | null {
  return scanChapter(source, "").references.find(
    (reference: Reference): boolean => offset >= reference.from && offset <= reference.to,
  ) ?? null;
}

/** Convert offsets in a raw snapshot to the native editor's LF text. */
export function editorOffset(source: string, offset: number): number {
  let result = offset;
  for (let index = source.indexOf("\r\n"); index >= 0 && index < offset; index = source.indexOf("\r\n", index + 2)) {
    result--;
  }
  return result;
}
