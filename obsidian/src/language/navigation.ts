import { scanChapter, type Reference } from "./index";

export { findTarget } from "./targets";
export { editorOffset } from "./coordinates";

export function referenceAt(source: string, offset: number): Reference | null {
  return scanChapter(source, "").references.find(
    (reference: Reference): boolean => offset >= reference.from && offset <= reference.to,
  ) ?? null;
}
