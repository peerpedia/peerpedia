import { inlineReferences, isValidLabel, scanBibliography, scanChapter, type LabelTarget, type Range, type Reference } from "../language/index";
import { projectMembers } from "../project/members";
import type { FileChange } from "../project/store";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import {
  entryCitationKeys, readEntries, renameEntry, rewriteBibliographyProse, type BibliographyEntry, type BibliographyProse,
} from "./document";

interface CitationReference extends Reference {
  entry?: string;
  field?: BibliographyProse["field"];
  version?: number;
}

export interface CitationUse extends CitationReference {
  path: string;
  line: number;
  column: number;
}

export interface CitationRename {
  changes: readonly FileChange[];
  references: readonly CitationUse[];
}

interface ChapterScan {
  file: SourceFile;
  references: Reference[];
  bibliographies: Range[];
}

interface Edit extends Range {
  text: string;
}

function bibliography(project: ProjectSnapshot): SourceFile {
  const file = project.files.find((item: SourceFile): boolean => item.path === project.config.bibliography);
  if (!file) throw new Error("找不到共享书目原文件。");
  return file;
}

function entry(file: SourceFile, key: string): BibliographyEntry {
  const found = readEntries(file.text).find((item: BibliographyEntry): boolean => item.key === key);
  if (!found) throw new Error(`找不到条目「${key}」。`);
  return found;
}

function scanChapters(project: ProjectSnapshot): { labels: LabelTarget[]; chapters: ChapterScan[] } {
  const labels: LabelTarget[] = [];
  const chapters: ChapterScan[] = [];
  for (const path of projectMembers(project.config).slice(1)) {
    if (path === project.config.bibliography) continue;
    const file = project.files.find((item: SourceFile): boolean => item.path === path);
    if (!file) throw new Error(`找不到正文原文件「${path}」。`);
    const scanned = scanChapter(file.text, path);
    if (scanned.diagnostics.length) throw new Error(`「${path}」包含无法读取的内嵌书目，请先修正。`);
    labels.push(...scanned.labels);
    chapters.push({ file, references: scanned.references, bibliographies: scanned.bibliographies });
  }
  return { labels, chapters };
}

function locateUses(file: SourceFile, references: CitationReference[]): CitationUse[] {
  references.sort((left: CitationReference, right: CitationReference): number => left.from - right.from);
  let line = 1;
  let lineStart = 0;
  let lineEnd = file.text.indexOf("\n");
  return references.map((reference: CitationReference): CitationUse => {
    while (lineEnd >= 0 && lineEnd < reference.from) {
      line++;
      lineStart = lineEnd + 1;
      lineEnd = file.text.indexOf("\n", lineStart);
    }
    return { ...reference, path: file.path, line, column: reference.from - lineStart + 1 };
  });
}

function referenceKeyRange(source: string, reference: Reference): Range {
  const braced = source.startsWith("{@", reference.from);
  let from = reference.from + (braced ? 2 : 1);
  const to = braced ? reference.to - 1 : reference.to;
  if (source[from] === "-" && source.slice(from + 1, to).normalize("NFC") === reference.key) from++;
  return { from, to };
}

function applyEdits(source: string, edits: Edit[]): string {
  edits.sort((left: Edit, right: Edit): number => right.from - left.from);
  let result = source;
  for (const { from, to, text } of edits) result = result.slice(0, from) + text + result.slice(to);
  return result;
}

function normalizedProse(value: string): { text: string; sourceOffset: (offset: number) => number } {
  const trimmed = value.trim();
  const leading = value.length - value.trimStart().length;
  const gaps: { after: number; removed: number }[] = [];
  let removed = 0;
  // Match BananaMark's prose whitespace normalization and retain a map back
  // to the decoded YAML scalar, before the scalar is written in its own style.
  const text = trimmed.replace(/\s+/gu, (space: string, offset: number): string => {
    const after = offset - removed + 1;
    removed += space.length - 1;
    if (space.length > 1) gaps.push({ after, removed });
    return " ";
  });
  return {
    text,
    sourceOffset(offset: number): number {
      let low = 0;
      let high = gaps.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (gaps[mid].after <= offset) low = mid + 1;
        else high = mid;
      }
      return leading + offset + (gaps[low - 1]?.removed ?? 0);
    },
  };
}

function proseUses(
  source: string, offset: number, keys: ReadonlySet<string>, references: CitationReference[], newKey?: string, exclude?: string,
): string {
  return rewriteBibliographyProse(source, (field: BibliographyProse): string => {
    if (field.entry === exclude) return field.value;
    const normalized = normalizedProse(field.value);
    const edits: Edit[] = [];
    for (const use of inlineReferences(normalized.text)) {
      if (!keys.has(use.key)) continue;
      // YAML escaping/folding can move a decoded character within the token.
      // The preview identifies the original field span and the entry/version.
      references.push({
        key: use.key, from: field.from + offset, to: field.to + offset,
        entry: field.entry, field: field.field, version: field.version,
      });
      if (newKey !== undefined) {
        const { from, to } = referenceKeyRange(normalized.text, use);
        edits.push({ from: normalized.sourceOffset(from), to: normalized.sourceOffset(to), text: newKey });
      }
    }
    return applyEdits(field.value, edits);
  });
}

function searchChapters(chapters: ChapterScan[], keys: ReadonlySet<string>, newKey?: string): CitationRename {
  const changes: FileChange[] = [];
  const references: CitationUse[] = [];
  for (const { file, references: chapterRefs, bibliographies } of chapters) {
    const matches: CitationReference[] = chapterRefs.filter((item: Reference): boolean => keys.has(item.key));
    const edits = newKey === undefined ? [] : matches.map((item: Reference): Edit =>
      ({ ...referenceKeyRange(file.text, item), text: newKey }));
    for (const { from, to } of bibliographies) {
      const yaml = file.text.slice(from, to);
      const after = proseUses(yaml, from, keys, matches, newKey);
      if (after !== yaml) edits.push({ from, to, text: after });
    }
    references.push(...locateUses(file, matches));
    if (edits.length) changes.push({ path: file.path, beforeDigest: file.digest, afterText: applyEdits(file.text, edits) });
  }
  return { changes, references };
}

export function citationImpact(project: ProjectSnapshot, key: string): readonly CitationUse[] {
  const file = bibliography(project);
  const keys = new Set(entryCitationKeys(entry(file, key)).map((name: string): string => name.normalize("NFC")));
  const { chapters } = scanChapters(project);
  const { references } = searchChapters(chapters, keys);
  const shared: CitationReference[] = [];
  proseUses(file.text, 0, keys, shared, undefined, key);
  return [...references, ...locateUses(file, shared)];
}

function checkedKey(key: string): string {
  const normalized = key.normalize("NFC");
  // Leading "-" is an operator in bare/braced citations.
  if (!isValidLabel(normalized) || normalized.startsWith("-")) throw new Error("请输入有效的引用键。");
  return normalized;
}

export function validateNewCitationKey(project: ProjectSnapshot, key: string): void {
  const normalized = checkedKey(key);
  const file = bibliography(project);
  readEntries(file.text);
  const { labels } = scanChapters(project);
  labels.push(...scanBibliography(file.text, file.path).labels);
  if (labels.some((item: LabelTarget): boolean => item.key === normalized)) {
    throw new Error(`引用键「${key}」已存在。`);
  }
}

export function previewCitationRename(project: ProjectSnapshot, from: string, to: string): CitationRename {
  const file = bibliography(project);
  entry(file, from);
  const oldKey = from.normalize("NFC");
  const newKey = checkedKey(to);
  if (from === to) throw new Error("请输入不同的引用键。");
  const { labels, chapters } = scanChapters(project);
  labels.push(...scanBibliography(file.text, file.path).labels);
  const oldLabels = labels.filter((item: LabelTarget): boolean => item.key === oldKey);
  if (oldLabels.length !== 1) throw new Error(`引用键「${from}」有多个定义或无法定位。`);
  if (oldKey !== newKey && labels.some((item: LabelTarget): boolean => item.key === newKey)) {
    throw new Error(`引用键「${to}」已存在。`);
  }
  const keys = new Set([oldKey]);
  const { changes, references } = searchChapters(chapters, keys, to);
  const shared: CitationReference[] = [];
  const yaml = proseUses(file.text, 0, keys, shared, to);
  const bibliographyChange = { path: file.path, beforeDigest: file.digest, afterText: renameEntry(yaml, from, to) };
  return { changes: [bibliographyChange, ...changes], references: [...references, ...locateUses(file, shared)] };
}

export function planCitationRename(project: ProjectSnapshot, from: string, to: string): readonly FileChange[] {
  return previewCitationRename(project, from, to).changes;
}
