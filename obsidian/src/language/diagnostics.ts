import { Text } from "@codemirror/state";
import { checkDocument, problemRange } from "bananamark-codemirror";

import { dialect, isValidLabel, type LabelTarget, type Range, type Reference } from "./index";

export interface Diagnostic extends Range {
  code?: "bibliography-yaml" | "publication-compatibility";
  path: string;
  message: string;
}

export function definitionDiagnostics(group: readonly LabelTarget[]): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const target of group) {
    const { key, path, from, to, label } = target;
    if (!isValidLabel(key)) {
      result.push({ path, from, to, message: `无效标签「${label}」。` });
    } else if (group.length > 1) {
      result.push({ path, from, to, message: `重复标签「${label}」。` });
    }
  }
  return result;
}

export function referenceDiagnostics(
  path: string,
  references: readonly Reference[],
  labels: ReadonlyMap<string, readonly LabelTarget[]>,
): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const { key, from, to } of references) {
    const count = labels.get(key)?.length ?? 0;
    if (count !== 1 || !isValidLabel(key)) {
      const message = !isValidLabel(key) ? `无效引用「${key}」。`
        : count === 0 ? `找不到引用「${key}」的定义。` : `引用「${key}」有多个定义。`;
      result.push({ path, from, to, message });
    }
  }
  return result;
}

export function checkChapter(
  path: string,
  source: string,
  labels: readonly LabelTarget[],
  known: readonly Diagnostic[],
): Diagnostic[] {
  const external = labels
    .filter((item: LabelTarget): boolean => item.path !== path)
    .map((item: LabelTarget): { name: string; text: string; page: string } =>
      ({ name: item.key, text: item.label, page: item.path }));
  // Keep raw UTF-16 offsets when reporting ranges for CRLF chapters. The
  // syntax check uses the same newline normalization as publication.
  const doc = Text.of(source.split("\n"));
  const problems = checkDocument(source.replace(/\r\n/g, "\n"), { dialect, labels: external, key: path });
  const result: Diagnostic[] = [];
  for (const problem of problems) {
    const range = problemRange(doc, problem.line, problem.column);
    // The project index already reports these errors at the label itself.
    if (["label_missing", "label_invalid", "label_duplicate", "label_duplicate_elsewhere"].includes(problem.code ?? "")) {
      const line = doc.line(Math.min(doc.lines, Math.max(1, problem.line)));
      if (known.some((issue: Diagnostic): boolean => issue.path === path && issue.from >= line.from && issue.from <= line.to)) continue;
    }
    result.push({ path, ...range, message: problem.message });
  }
  return result;
}

export function checkBibliography(path: string, source: string): Diagnostic[] {
  if (!source.trim()) return [];
  let width = 3;
  for (const match of source.matchAll(/~+/g)) width = Math.max(width, match[0].length + 1);
  const fence = "~".repeat(width);
  const doc = Text.of(source.split("\n"));
  return checkDocument(`${fence}bibliography\n${source.replace(/\r\n/g, "\n")}\n${fence}`, { dialect })
    .map((problem: { line: number; column?: number; message: string }): Diagnostic => ({
      path, ...problemRange(doc, problem.line - 1, problem.column), message: problem.message,
    }));
}
