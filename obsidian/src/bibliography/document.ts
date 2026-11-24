import { UserFacingError } from "../user-error";
import { CST, isMap, isScalar, isSeq, parseDocument, stringify, visit, type Document, type Pair, type ParsedNode, type Scalar, type YAMLMap } from "yaml";

export interface BibliographyEntry {
  key: string;
  fields: Readonly<Record<string, unknown>>;
}

type Fields = BibliographyEntry["fields"];
type StringKey = Scalar.Parsed & { value: string };
type Mapping = YAMLMap.Parsed<StringKey, ParsedNode | null>;
type EntryPair = Pair<StringKey, Mapping>;
type BibliographyDocument = {
  doc: Document.Parsed;
  mapping?: Mapping;
  pairs: readonly EntryPair[];
  entries: readonly BibliographyEntry[];
};

function stringKeys(node: unknown): node is Mapping {
  return isMap(node) && node.items.every((pair: Pair<unknown, unknown>): boolean =>
    isScalar(pair.key) && typeof pair.key.value === "string");
}

export function parseBibliography(source: string): BibliographyDocument {
  const doc = parseDocument(source, { keepSourceTokens: true });
  const issue = doc.errors[0] ?? doc.warnings[0];
  if (issue) throw new UserFacingError(`Unable to read bibliography YAML: ${issue.message.split("\n")[0]}`);
  const mapping = doc.contents;
  if (mapping === null || (isScalar(mapping) && mapping.value === null && mapping.source === "")) {
    return { doc, pairs: [], entries: [] };
  }
  if (!stringKeys(mapping)) throw new UserFacingError("Bibliography entries must use text citation keys. Check the source file.");
  if (mapping.items.some((pair: Pair<StringKey, ParsedNode | null>): boolean => !stringKeys(pair.value))) {
    throw new UserFacingError("Each bibliography entry must map field names to values. Check the source file.");
  }
  doc.options.logLevel = "silent";
  let fields: Record<string, Fields>;
  try {
    fields = doc.toJS({ maxAliasCount: 50 });
  } catch (error: unknown) {
    throw new UserFacingError("Unable to resolve a YAML alias in the bibliography. Check the source file.", { cause: error });
  }
  const pairs = mapping.items as EntryPair[];
  const entries = pairs.map((pair: EntryPair): BibliographyEntry => ({ key: pair.key.value, fields: fields[pair.key.value] }));
  return { doc, mapping, pairs, entries };
}

export function readEntries(source: string): readonly BibliographyEntry[] {
  return parseBibliography(source).entries;
}

function lineEnding(source: string): string {
  return /\r?\n/.exec(source)?.[0] ?? "\n";
}

/** Textareas normalize CR/LF. Keep the existing endings at the edit boundaries. */
export function restoreSourceLineEndings(source: string, draft: string): string {
  const endings = source.match(/\r\n?|\n/g) ?? [];
  const fallback = endings[0] ?? "\n";
  if (endings.every((ending: string): boolean => ending === fallback)) return draft.replaceAll("\n", fallback);

  const previous = source.split(/\r\n?|\n/);
  const current = draft.split("\n");
  let start = 0;
  while (start < previous.length && previous[start] === current[start]) start++;
  let oldEnd = previous.length;
  let newEnd = current.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === current[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return current.map((line: string, index: number): string => {
    if (index === current.length - 1) return line;
    const corresponding = index < start ? index : index >= newEnd ? index + oldEnd - newEnd : Math.min(index, oldEnd - 1);
    return line + (endings[corresponding] ?? fallback);
  }).join("");
}

function replace(source: string, from: number, to: number, text: string): string {
  return source.slice(0, from) + text + source.slice(to);
}

function entryPair(pairs: readonly EntryPair[], key: string): EntryPair {
  const pair = pairs.find((item: EntryPair): boolean => item.key.value === key);
  if (!pair) throw new UserFacingError(`Entry "${key}" was not found.`);
  return pair;
}

function renderValue(doc: Document.Parsed, value: unknown, previous?: ParsedNode): string {
  const type = isScalar(previous) ? previous.type : undefined;
  const quoted = typeof value === "string" && /[\r\n]/.test(value) ? "QUOTE_DOUBLE"
    : type === "QUOTE_SINGLE" || type === "QUOTE_DOUBLE" ? type : "PLAIN";
  return stringify(value, {
    schema: doc.schema, collectionStyle: "flow", lineWidth: 0, blockQuote: false, defaultStringType: quoted,
  }).trimEnd();
}

function isAnchored(node: unknown): boolean {
  return (isScalar(node) || isMap(node) || isSeq(node)) && Boolean(node.anchor);
}

function sharedDataError(field: string): Error {
  return new UserFacingError(`${field} uses shared YAML data. Review and edit the YAML source file.`);
}

function assertIndependentEdit(field: string, owners: readonly unknown[], value?: ParsedNode): void {
  if (owners.some(isAnchored)) throw sharedDataError(field);
  if (!value) return;
  visit(value, (_key: unknown, child: unknown): void => {
    if (isAnchored(child)) throw sharedDataError(field);
  });
}

function replaceValue(source: string, doc: Document.Parsed, node: ParsedNode, value: unknown): string {
  const [from, to] = node.range;
  if (from === to) {
    const before = source[from - 1] === ":" ? " " : "";
    const after = source[from] === "#" ? " " : "";
    return replace(source, from, to, before + renderValue(doc, value) + after);
  }
  if (node.srcToken?.type === "block-scalar" && typeof value === "string") {
    const token = structuredClone(node.srcToken);
    CST.setScalarValue(token, value, { afterKey: true });
    const oldText = CST.stringify(node.srcToken);
    // Existing CST trivia keeps its original newline sequence.
    const text = CST.stringify(token).replace(/\r?\n/g, lineEnding(oldText));
    return replace(source, from, from + oldText.length, text);
  }
  const outgoing = source.slice(from, to);
  const trailing = isMap(node) || node.srcToken?.type === "block-seq"
    ? /\r?\n[ \t]*$/.exec(outgoing)?.[0] ?? "" : "";
  let text = renderValue(doc, value, node);
  if (node.srcToken?.type === "block-scalar") {
    const token = node.srcToken;
    text += token.props.slice(1).map(CST.stringify).join("");
  }
  return replace(source, from, to, text + trailing);
}

export function renameEntry(source: string, from: string, to: string): string {
  const parsed = parseBibliography(source);
  const { key } = entryPair(parsed.pairs, from);
  assertIndependentEdit(`Citation key "${from}"`, [parsed.mapping], key);
  const replacement = renderValue(parsed.doc, to, key);
  const updated = replace(source, key.range[0], key.range[1], replacement);
  entryPair(parseBibliography(updated).pairs, to);
  return updated;
}

export interface BibliographyProse {
  entry: string;
  version?: number;
  field: "note" | "howpublished";
  value: string;
  from: number;
  to: number;
}

/** BananaMark renders Markdown in these two fields, including on versions. */
export function rewriteBibliographyProse(source: string, update: (field: BibliographyProse) => string): string {
  const parsed = parseBibliography(source);
  const edits: { node: ParsedNode; value: string }[] = [];
  const inspect = (
    nodes: unknown, fields: Fields, key: StringKey, owners: readonly unknown[], version?: number,
  ): void => {
    for (const field of ["note", "howpublished"] as const) {
      const value = fields[field];
      if (typeof value !== "string") continue;
      const pair = stringKeys(nodes)
        ? nodes.items.find((item: Pair<StringKey, ParsedNode | null>): boolean => item.key.value === field)
        : undefined;
      const node = pair?.value;
      const [from, to] = node?.range ?? key.range;
      const after = update({ entry: key.value, version, field, value, from, to });
      if (after === value) continue;
      const position = version === undefined ? "" : ` (version ${version})`;
      const description = `Field "${field}" in entry "${key.value}"${position}`;
      if (!node) throw sharedDataError(description);
      assertIndependentEdit(description, [...owners, nodes], node);
      edits.push({ node, value: after });
    }
  };
  parsed.pairs.forEach((pair: EntryPair, index: number): void => {
    const { fields } = parsed.entries[index];
    inspect(pair.value, fields, pair.key, [parsed.mapping]);
    if (!Array.isArray(fields.versions)) return;
    const versions = pair.value?.get("versions", true);
    for (const [number, version] of fields.versions.entries()) {
      if (!version || typeof version !== "object" || Array.isArray(version)) continue;
      inspect(isSeq(versions) ? versions.items[number] : undefined, version, pair.key,
        [parsed.mapping, pair.value, versions], number + 1);
    }
  });
  edits.sort((left: { node: ParsedNode }, right: { node: ParsedNode }): number => right.node.range[0] - left.node.range[0]);
  let result = source;
  for (const { node, value } of edits) result = replaceValue(result, parsed.doc, node, value);
  if (edits.length) parseBibliography(result);
  return result;
}
