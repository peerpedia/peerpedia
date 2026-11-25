import { projectMembers } from "../project/members";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import { checkBibliography, checkChapter, definitionDiagnostics, referenceDiagnostics, type Diagnostic } from "./diagnostics";
import { isValidLabel, scanBibliography, scanChapter, type LabelTarget, type Reference, type SyntaxMark } from "./index";
import { editorCoordinates } from "./coordinates";

export interface ProjectAnalysis {
  revision: string;
  labels: readonly LabelTarget[];
  diagnostics: readonly Diagnostic[];
}

export interface ChapterLanguage {
  marks: readonly SyntaxMark[];
  references: readonly Reference[];
  diagnostics: readonly Diagnostic[];
}

export interface WritingAnalysis {
  analysis: ProjectAnalysis;
  chapters: ReadonlyMap<string, ChapterLanguage>;
}

interface IndexedSource {
  file: SourceFile;
  bibliography: boolean;
  labels: readonly LabelTarget[];
  references: readonly Reference[];
  marks: readonly SyntaxMark[];
  diagnostics: readonly Diagnostic[];
  validation?: { key: string; diagnostics: readonly Diagnostic[] };
}

export type SourceAnalysisCache = Map<string, IndexedSource>;

function indexSources(project: ProjectSnapshot, cache: SourceAnalysisCache): IndexedSource[] {
  const files = new Map(project.files.map((file: SourceFile): readonly [string, SourceFile] => [file.path, file]));
  const members = new Set(projectMembers(project.config).slice(1));
  for (const path of cache.keys()) if (!members.has(path)) cache.delete(path);
  const indexed: IndexedSource[] = [];
  for (const path of members) {
    const file = files.get(path);
    if (!file) continue;
    const bibliography = path === project.config.bibliography;
    let source = cache.get(path);
    if (!source || source.file.digest !== file.digest || source.bibliography !== bibliography) {
      const scan = bibliography
        ? { ...scanBibliography(file.text, path), references: [], marks: [] }
        : scanChapter(file.text, path);
      source = { file, bibliography, ...scan };
      cache.set(path, source);
    }
    indexed.push(source);
  }
  return indexed;
}

export function projectLabels(project: ProjectSnapshot, cache: SourceAnalysisCache): LabelTarget[] {
  return indexSources(project, cache).flatMap((source: IndexedSource): readonly LabelTarget[] => source.labels);
}

export function analyzeWriting(project: ProjectSnapshot, cache: SourceAnalysisCache): WritingAnalysis {
  const sources = indexSources(project, cache);
  const labels: LabelTarget[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const source of sources) {
    labels.push(...source.labels);
    diagnostics.push(...source.diagnostics);
    if (source.bibliography && source.diagnostics.length === 0) {
      source.validation ??= {key: "", diagnostics: checkBibliography(source.file.path, source.file.text)};
      diagnostics.push(...source.validation.diagnostics);
    }
  }

  const groups = new Map<string, LabelTarget[]>();
  for (const label of labels) {
    let group = groups.get(label.key);
    if (!group) {
      group = [];
      groups.set(label.key, group);
    }
    group.push(label);
  }
  for (const group of groups.values()) diagnostics.push(...definitionDiagnostics(group));
  for (const { file, references } of sources) diagnostics.push(...referenceDiagnostics(file.path, references, groups));

  // If a definition is ambiguous, still declare it once for syntax checks in
  // other chapters. The project diagnostics explain why it cannot be followed.
  const unique = [...groups.values()]
    .map((group: LabelTarget[]): LabelTarget => group[0])
    .filter((target: LabelTarget): boolean => isValidLabel(target.key));
  for (const source of sources) {
    if (source.bibliography) continue;
    const {file} = source;
    // Text changes replace the IndexedSource. External declarations and local
    // diagnostic offsets also affect validation and duplicate-error suppression.
    const key = JSON.stringify([
      unique.filter((label: LabelTarget): boolean => label.path !== file.path)
        .map((label: LabelTarget): string[] => [label.key, label.label, label.path]),
      diagnostics.filter((issue: Diagnostic): boolean => issue.path === file.path)
        .map((issue: Diagnostic): number => issue.from),
    ]);
    if (source.validation?.key !== key) {
      source.validation = {key, diagnostics: checkChapter(file.path, file.text, unique, diagnostics)};
    }
    diagnostics.push(...source.validation.diagnostics);
  }

  const chapters = new Map<string, ChapterLanguage>();
  for (const { file, bibliography, references, marks } of sources) {
    if (bibliography) continue;
    const coordinates = editorCoordinates(file.text);
    const chapterDiagnostics = diagnostics.filter((issue: Diagnostic): boolean => issue.path === file.path);
    chapters.set(file.path, {
      references: references.map(coordinates),
      marks: marks.map(coordinates),
      diagnostics: chapterDiagnostics.map(coordinates),
    });
  }
  return { analysis: { revision: project.revision, labels, diagnostics }, chapters };
}

export function analyzeProject(project: ProjectSnapshot): ProjectAnalysis {
  return analyzeWriting(project, new Map()).analysis;
}
