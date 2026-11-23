import { EditorState } from "@codemirror/state";
import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import { BananamarkError, defineDialect } from "bananamark";
import { escaped, labelledMarkerSource } from "bananamark/scan";
import { readMarkdownLink, readReference, transformMarkup } from "bananamark/internal/markup.mjs";
import { withNodes } from "bananamark/internal/nodes.mjs";
import { withSyntax } from "bananamark/internal/switches.mjs";
import { parseLists } from "bananamark/internal/lists.mjs";
import { validReferenceName } from "bananamark/internal/scan.mjs";
import { declaredLabels } from "bananamark-codemirror";
import { isMap, isNode, isScalar, isSeq, parseDocument, type Node, type YAMLMap } from "yaml";

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

function yamlKey(source: string, path: string, node: Node, start: number, label: unknown): LabelTarget | null {
  if (typeof label !== "string" || !node.range) return null;
  let [from, to] = node.range;
  const text = source.slice(from, to);
  if ((text[0] === "'" || text[0] === '"') && text.slice(1, -1) === label) {
    from++;
    to--;
  }
  return defineLabel(path, "bibliography", label, from + start, to + start);
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

  // BananaMark uses the resolved values, including aliases, to register
  // version keys. Keep navigating to the key's own source occurrence.
  let resolved: Record<string, { versions?: unknown }> | undefined;
  try {
    doc.options.logLevel = "silent";
    resolved = doc.toJS({ maxAliasCount: 50 });
  } catch {
    // Retain directly authored definitions in an incomplete YAML draft.
  }
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key)) continue;
    const entry = yamlKey(source, path, pair.key, start, pair.key.value);
    if (!entry) continue;
    labels.push(entry);
    const versions = isMap(pair.value) ? field(pair.value, "versions") : undefined;
    const resolvedVersions = resolved?.[entry.label]?.versions;
    const count = Array.isArray(resolvedVersions) ? resolvedVersions.length : isSeq(versions) ? versions.items.length : 0;
    for (let index = 0; index < count; index++) {
      const item = isSeq(versions) ? versions.items[index] : versions ?? pair.value;
      const node = isMap(item) ? field(item, "key") : item;
      const value: unknown = Array.isArray(resolvedVersions) ? resolvedVersions[index]?.key : isScalar(node) ? node.value : undefined;
      if (typeof value !== "string" && typeof value !== "number") continue;
      const label = String(value).trim().replace(/\s+/gu, " ");
      const target = yamlKey(source, path, isNode(node) ? node : pair.key, start, label);
      if (target) labels.push(target);
    }
  }
  return { labels, diagnostics };
}

// The editor grammar treats TikZ fence metadata and ordinary link text as
// opaque for reference resolution. Ask the renderer's own inline scanner for
// references in the captions it actually renders, with offsets into the input.
function captionReferences(source: string, offset: number, tikz: boolean): Reference[] {
  const references: Reference[] = [];
  try {
    withSyntax({ tikz }, (): void => {
      withNodes([], (): void => {
        transformMarkup(source, [], {
          indentedCode: false,
          resolveReference(key: string, position: number, label?: string): { label: string; node: object } {
            if (label === undefined) {
              const token = readReference(source, position);
              if (token?.key !== undefined) {
                references.push({ key: key.replace(/^-/, "").normalize("NFC"), from: offset + position, to: offset + token.end });
              }
            } else {
              const link = readMarkdownLink(source, position);
              if (link?.reference !== undefined) {
                references.push(...captionReferences(label, offset + position + 1, false));
                const to = offset + link.end - 1;
                references.push({ key: key.normalize("NFC"), from: to - key.length - 1, to });
              }
            }
            return { label: "", node: { type: "reference" } };
          },
        });
      });
    });
  } catch (error: unknown) {
    // Drafts can have incomplete or invalid markup in their captions.
    if (!(error instanceof BananamarkError)) throw error;
  }
  return references;
}

export function inlineReferences(source: string): readonly Reference[] {
  return captionReferences(source, 0, false);
}

export function scanChapter(source: string, path: string): {
  labels: LabelTarget[];
  references: Reference[];
  marks: SyntaxMark[];
  diagnostics: Diagnostic[];
  bibliographies: Range[];
} {
  const labels: LabelTarget[] = [];
  const references: Reference[] = [];
  const marks: SyntaxMark[] = [];
  const diagnostics: Diagnostic[] = [];
  const bibliographies: Range[] = [];
  const definitions = new Set<number>();
  let escapedReferenceEnd = 0;
  const addLabels = (targets: readonly LabelTarget[]): void => {
    for (const target of targets) {
      definitions.add(target.from);
      labels.push(target);
      if (target.from < target.to) marks.push({ from: target.from, to: target.to, kind: "label" });
    }
  };

  const addReference = (reference: Reference): void => {
    references.push(reference);
    marks.push({ from: reference.from, to: reference.to, kind: "reference" });
  };

  addLabels(itemLabels(source, path));
  parseSource(source).iterate({
    enter(ref: SyntaxNodeRef): false | void {
      const { name, from, to, node } = ref;
      if (from < escapedReferenceEnd) return false;
      if (name === "Escape" && source.startsWith("\\{@", from)) {
        const literal = readReference(source, from + 1, { ignoreEscape: true });
        if (literal?.key !== undefined) escapedReferenceEnd = literal.end;
      }
      addLabels(attrsFrom(source, node, path));
      if (name === "FencedCode") {
        const language = fenceLanguage(source, node);
        if (language === "bibliography") {
          const lineEnd = source.indexOf("\n", from);
          if (lineEnd >= 0 && lineEnd < to) {
            const end = node.lastChild?.name === "CodeMark" ? node.lastChild.from : to;
            const start = lineEnd + 1;
            bibliographies.push({ from: start, to: end });
            const bib = scanBibliography(source.slice(start, end), path, start);
            addLabels(bib.labels);
            diagnostics.push(...bib.diagnostics);
          }
        } else if (language && /^(?:math|tikz|tex|latex)$/.test(language)) {
          marks.push({ from, to, kind: "formula" });
          if (language === "tikz" && node.lastChild?.name === "CodeMark") {
            const opening = source.slice(from, source.indexOf("\n", from)).trimEnd();
            if (opening.includes("caption=")) {
              const closing = source.slice(node.lastChild.from, node.lastChild.to);
              captionReferences(opening + "\n" + closing, from, true).forEach(addReference);
            }
          }
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
        addReference({ key, from, to });
        return false;
      }
      if (name === "Link") {
        if (readMarkdownLink(source, from)?.reference !== undefined) {
          captionReferences(source.slice(from, to), from, false).forEach(addReference);
        }
        return false;
      }
    },
  });

  labels.sort((left: LabelTarget, right: LabelTarget): number => left.from - right.from);
  references.sort((left: Reference, right: Reference): number => left.from - right.from);
  return { labels, references, marks, diagnostics, bibliographies };
}

export function isValidLabel(key: string): boolean {
  return validReferenceName(key);
}
