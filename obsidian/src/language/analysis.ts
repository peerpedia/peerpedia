import { projectMembers } from "../project/store";
import type { ProjectSnapshot, SourceFile } from "../project/types";
import { checkBibliography, checkChapter, definitionDiagnostics, referenceDiagnostics, type Diagnostic } from "./diagnostics";
import { isValidLabel, scanBibliography, scanChapter, type LabelTarget, type Reference } from "./index";

export interface ProjectAnalysis {
  revision: string;
  labels: readonly LabelTarget[];
  diagnostics: readonly Diagnostic[];
}

export function analyzeProject(project: ProjectSnapshot): ProjectAnalysis {
  const files = new Map(project.files.map((file: SourceFile): readonly [string, SourceFile] => [file.path, file]));
  const labels: LabelTarget[] = [];
  const diagnostics: Diagnostic[] = [];
  const chapters: { file: SourceFile; references: readonly Reference[] }[] = [];
  for (const path of projectMembers(project.config).slice(1)) {
    const file = files.get(path);
    if (!file) continue;
    if (path === project.config.bibliography) {
      const bib = scanBibliography(file.text, path);
      labels.push(...bib.labels);
      diagnostics.push(...bib.diagnostics);
      if (bib.diagnostics.length === 0) diagnostics.push(...checkBibliography(path, file.text));
    } else {
      const chapter = scanChapter(file.text, path);
      labels.push(...chapter.labels);
      diagnostics.push(...chapter.diagnostics);
      chapters.push({ file, references: chapter.references });
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
  for (const { file, references } of chapters) diagnostics.push(...referenceDiagnostics(file.path, references, groups));

  // If a definition is ambiguous, still declare it once for syntax checks in
  // other chapters. The project diagnostics explain why it cannot be followed.
  const unique = [...groups.values()]
    .map((group: LabelTarget[]): LabelTarget => group[0])
    .filter((target: LabelTarget): boolean => isValidLabel(target.key));
  for (const { file } of chapters) diagnostics.push(...checkChapter(file.path, file.text, unique, diagnostics));

  return { revision: project.revision, labels, diagnostics };
}
