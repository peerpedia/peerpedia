import { EditorState } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { defineDialect } from "bananamark";
import { escaped, labelledMarkerSource } from "bananamark/scan";
import { parseLists } from "bananamark/internal/lists.mjs";
import { validReferenceName } from "bananamark/internal/scan.mjs";
import { declaredLabels } from "bananamark-codemirror";
import { isMap, isScalar, isSeq, parseDocument, type Scalar, type YAMLMap } from "yaml";

import { dialectOptions } from "../../../editor/dialect.js";
import type { Diagnostic } from "./diagnostics";

export interface Range {
  from: number;
  to: number;
}

export interface LabelTarget extends Range {
  key: string;
  label: string;
  kind: "heading" | "theorem" | "equation" | "bibliography" | "item";
  path: string;
}

export interface Reference extends Range {
  key: string;
}

export interface SyntaxMark extends Range {
  kind: "environment" | "formula" | "reference" | "label";
}

export const dialect = defineDialect(dialectOptions);
const parser = dialect.language.language.parser;
const literals = new Set(["InlineCode", "FencedCode", "CodeBlock", "Comment", "FrontMatter", "HTMLComment"]);
const math = new Set(["InlineMath", "DisplayMath"]);
const heading = /^(?:ATX|Setext)Heading[1-6]$/;
const possibleItemLabel = new RegExp(String.raw`(?:\d{1,9}[.)]|${labelledMarkerSource})[ \t]+\{@`);
const labelAttribute = /\{([^{}\n]*)\}(?=[ \t]*\*?[ \t]*(?:#+[ \t]*)?\r?$)/;

export function parseSource(source: string): Tree {
  return parser.parse(source);
}

export function completionState(source: string): EditorState {
  // This state never backs an EditorView. It exists for upstream completion
  // helpers that ask syntaxTree() for BananaMark nodes.
  return EditorState.create({
    doc: source,
    extensions: [dialect.language, EditorState.lineSeparator.of("\n")],
  });
}

export function containingNode(tree: Tree, offset: number, names: ReadonlySet<string>): SyntaxNode | null {
  for (let node: SyntaxNode | null = tree.resolveInner(offset, -1); node; node = node.parent) {
    if (names.has(node.name)) return node;
  }
  return null;
}

export function literalAt(tree: Tree, offset: number): SyntaxNode | null {
  return containingNode(tree, offset, literals);
}

export function fenceLanguage(source: string, node: SyntaxNode): string | undefined {
  const start = node.firstChild?.to ?? node.from;
  const end = source.indexOf("\n", start);
  return /^[ \t]*([\w-]+)/.exec(source.slice(start, end < 0 ? node.to : end))?.[1];
}

function defineLabel(path: string, kind: LabelTarget["kind"], label: string, from: number, to: number): LabelTarget {
  return { path, kind, label, key: label.normalize("NFC"), from, to };
}

function attributeLabels(
  source: string, from: number, to: number, path: string, kind: LabelTarget["kind"],
): LabelTarget[] {
  const text = source.slice(from, to);
  const attr = labelAttribute.exec(text);
  if (!attr || escaped(text, attr.index)) return [];
  const contents = attr[1];
  const offset = from + attr.index + 1;
  const scanned = declaredLabels(text)[0];
  if (scanned && contents === `@${scanned.name}`) {
    return [defineLabel(path, kind, scanned.name, offset + 1, offset + contents.length)];
  }
  // The tolerant scanner handles the common forms. The independent grammar
  // also exposes setext headings, tilde fences and combined heading attributes.
  if (kind === "heading") {
    const matches = [...contents.matchAll(/(?:^|[ \t])@([^ \t]*)/g)];
    const otherAttrs = /(?:^|[ \t])(?:\.[\w-]+|[\w-]+=)/.test(contents);
    if (matches.length > 1 || otherAttrs) {
      return matches.map((match: RegExpMatchArray): LabelTarget => {
        const start = offset + (match.index ?? 0) + match[0].indexOf("@") + 1;
        return defineLabel(path, kind, match[1], start, start + match[1].length);
      });
    }
  }
  if (!contents.startsWith("@")) return [];
  return [defineLabel(path, kind, contents.slice(1), offset + 1, offset + contents.length)];
}

function itemLabels(source: string, path: string): LabelTarget[] {
  if (!possibleItemLabel.test(source)) return [];
  const normalizedBreaks = Array.from(source.matchAll(/\r\n/g),
    (match: RegExpMatchArray, removed: number): number => (match.index ?? 0) - removed,
  );
  const items = parseLists(source.replace(/\r\n?/g, "\n")).items;
  const labels: LabelTarget[] = [];
  let removed = 0;
  for (const { id, start, end } of items) {
    // parseLists walks the source in order. The declaration is on one line.
    while (removed < normalizedBreaks.length && normalizedBreaks[removed] < start) removed++;
    labels.push(defineLabel(path, "item", id, start + removed + 2, end + removed - 1));
  }
  return labels;
}

function attrsFrom(source: string, node: SyntaxNode, path: string): LabelTarget[] {
  if (heading.test(node.name)) {
    const end = node.name.startsWith("Setext") ? node.lastChild?.from ?? node.to : node.to;
    const text = source.slice(node.from, end).trimEnd();
    return attributeLabels(source, node.from, node.from + text.length, path, "heading");
  }
  if (node.name === "EnvironmentFence" && node.getChild("EnvironmentName")) {
    return attributeLabels(source, node.from, node.to, path, "theorem");
  }
  if (node.name === "FencedCode" && fenceLanguage(source, node) === "math") {
    const lineEnd = source.indexOf("\n", node.from);
    return attributeLabels(source, node.from, lineEnd < 0 ? node.to : lineEnd, path, "equation");
  }
  return [];
}

function yamlKey(source: string, path: string, scalar: Scalar<unknown>, start: number): LabelTarget | null {
  if (typeof scalar.value !== "string" || !scalar.range) return null;
  let [from, to] = scalar.range;
  const text = source.slice(from, to);
  if ((text[0] === "'" || text[0] === '"') && text.slice(1, -1) === scalar.value) {
    from++;
    to--;
  }
  return defineLabel(path, "bibliography", scalar.value, from + start, to + start);
}

function field(map: YAMLMap<unknown, unknown>, key: string): unknown {
  return map.get(key, true);
}

export function scanBibliography(source: string, path: string, start: number = 0): { labels: LabelTarget[]; diagnostics: Diagnostic[] } {
  const doc = parseDocument(source, { uniqueKeys: false });
  const labels: LabelTarget[] = [];
  const diagnostics = doc.errors.map((error: { pos: [number, number]; message: string }): Diagnostic => ({
    path, from: start + error.pos[0], to: start + error.pos[1], message: error.message.split("\n")[0],
  }));
  if (!isMap(doc.contents)) return { labels, diagnostics };
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key)) continue;
    const entry = yamlKey(source, path, pair.key, start);
    if (entry) labels.push(entry);
    if (!isMap(pair.value)) continue;
    const versions = field(pair.value, "versions");
    if (!isSeq(versions)) continue;
    for (const version of versions.items) {
      if (!isMap(version)) continue;
      const key = field(version, "key");
      if (!isScalar(key)) continue;
      const target = yamlKey(source, path, key, start);
      if (target) labels.push(target);
    }
  }
  return { labels, diagnostics };
}

export function scanChapter(source: string, path: string): {
  labels: LabelTarget[];
  references: Reference[];
  marks: SyntaxMark[];
  diagnostics: Diagnostic[];
} {
  const labels: LabelTarget[] = [];
  const references: Reference[] = [];
  const marks: SyntaxMark[] = [];
  const diagnostics: Diagnostic[] = [];
  const definitions = new Set<number>();
  const addLabels = (targets: readonly LabelTarget[]): void => {
    for (const target of targets) {
      definitions.add(target.from);
      labels.push(target);
      if (target.from < target.to) marks.push({ from: target.from, to: target.to, kind: "label" });
    }
  };

  addLabels(itemLabels(source, path));
  parseSource(source).iterate({
    enter(ref: SyntaxNodeRef): false | void {
      const { name, from, to, node } = ref;
      addLabels(attrsFrom(source, node, path));
      if (name === "FencedCode") {
        const language = fenceLanguage(source, node);
        if (language === "bibliography") {
          const lineEnd = source.indexOf("\n", from);
          if (lineEnd >= 0 && lineEnd < to) {
            const end = node.lastChild?.name === "CodeMark" ? node.lastChild.from : to;
            const bib = scanBibliography(source.slice(lineEnd + 1, end), path, lineEnd + 1);
            addLabels(bib.labels);
            diagnostics.push(...bib.diagnostics);
          }
        } else if (language && /^(?:math|tikz|tex|latex)$/.test(language)) {
          marks.push({ from, to, kind: "formula" });
        }
        // Code examples can contain a mounted Markdown grammar.
        return false;
      }
      if (math.has(name)) {
        marks.push({ from, to, kind: "formula" });
        return false;
      }
      if (literals.has(name)) return false;
      if (name === "EnvironmentName" || name === "EnvironmentMark") marks.push({ from, to, kind: "environment" });
      if (name === "Reference") {
        const braced = source.startsWith("{@", from);
        const start = from + (braced ? 2 : 1);
        if (definitions.has(start)) return false;
        const key = source.slice(start, braced ? to - 1 : to).replace(/^-/, "").normalize("NFC");
        references.push({ key, from, to });
        marks.push({ from, to, kind: "reference" });
        return false;
      }
      if (name === "Link" && !escaped(source, from)) {
        const link = /\]\((@([^\s()]+))\)$/.exec(source.slice(from, to));
        if (link) {
          const start = from + link.index + 2;
          references.push({ key: link[2].normalize("NFC"), from: start, to: to - 1 });
          marks.push({ from: start, to: to - 1, kind: "reference" });
        }
        return false;
      }
    },
  });

  labels.sort((left: LabelTarget, right: LabelTarget): number => left.from - right.from);
  return { labels, references, marks, diagnostics };
}

export function isValidLabel(key: string): boolean {
  return validReferenceName(key);
}
