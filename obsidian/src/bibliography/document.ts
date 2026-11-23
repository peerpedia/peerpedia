import { CST, isMap, isScalar, isSeq, parseDocument, stringify, type Document, type Pair, type ParsedNode, type Scalar, type YAMLMap } from "yaml";

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

function parse(source: string): BibliographyDocument {
  const doc = parseDocument(source, { keepSourceTokens: true });
  const issue = doc.errors[0] ?? doc.warnings[0];
  if (issue) throw new Error(`无法读取书目 YAML：${issue.message.split("\n")[0]}`);
  const mapping = doc.contents;
  if (mapping === null || (isScalar(mapping) && mapping.value === null && mapping.source === "")) {
    return { doc, pairs: [], entries: [] };
  }
  if (!stringKeys(mapping)) throw new Error("书目须以文本引用键组织条目。请检查原文件。");
  if (mapping.items.some((pair: Pair<StringKey, ParsedNode | null>): boolean => !stringKeys(pair.value))) {
    throw new Error("每个书目条目须包含字段映射。请检查原文件。");
  }
  doc.options.logLevel = "silent";
  let fields: Record<string, Fields>;
  try {
    fields = doc.toJS({ maxAliasCount: 50 });
  } catch (error: unknown) {
    throw new Error("无法解析书目中的 YAML 别名。请检查原文件。", { cause: error });
  }
  const pairs = mapping.items as EntryPair[];
  const entries = pairs.map((pair: EntryPair): BibliographyEntry => ({ key: pair.key.value, fields: fields[pair.key.value] }));
  return { doc, mapping, pairs, entries };
}

export function readEntries(source: string): readonly BibliographyEntry[] {
  return parse(source).entries;
}

export function entryCitationKeys(entry: BibliographyEntry): string[] {
  const keys = [entry.key];
  const { versions } = entry.fields;
  if (Array.isArray(versions)) {
    for (const version of versions) {
      if (version && typeof version === "object" && typeof version.key === "string") keys.push(version.key);
    }
  }
  return keys;
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
  if (!pair) throw new Error(`找不到条目「${key}」。`);
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

function appendPairs(source: string, parsed: BibliographyDocument, mapping: Mapping | undefined, fields: Fields): string {
  const token = mapping?.srcToken;
  if (token?.type === "flow-collection") {
    const close = token.end.find((item: CST.SourceToken): boolean => item.type === "flow-map-end")!;
    const last = mapping!.items.at(-1)?.value;
    const trailingComma = token.items.at(-1)?.start.some((item: CST.SourceToken): boolean => item.type === "comma") &&
      token.items.at(-1)?.key === undefined;
    const additions = renderValue(parsed.doc, fields).slice(2, -2);
    const withFields = replace(source, close.offset, close.offset, additions);
    return last && !trailingComma ? replace(withFields, last.range[1], last.range[1], ", ") : withFields;
  }
  const indent = token?.type === "block-map" ? " ".repeat(token.indent) : "";
  const offset = mapping?.range[2] ?? (parsed.doc.directives.docEnd ? parsed.doc.range[1] : source.length);
  const newline = lineEnding(source);
  const before = source.slice(0, offset);
  const prefix = before && !before.endsWith("\n") && before !== "\uFEFF" ? newline : "";
  const generated = stringify(fields, { schema: parsed.doc.schema, lineWidth: 0 })
    .trimEnd().split("\n").map((line: string): string => line ? indent + line : "").join(newline);
  return before + prefix + generated + newline + source.slice(offset);
}

export function patchEntry(source: string, key: string, patch: Fields): string {
  let updated = source;
  for (const [name, value] of Object.entries(patch)) {
    const parsed = parse(updated);
    const pair = entryPair(parsed.pairs, key);
    const field = pair.value!.items.find((item: Pair<StringKey, ParsedNode | null>): boolean => item.key.value === name);
    if (!field) {
      updated = appendPairs(updated, parsed, pair.value!, { [name]: value });
    } else if (field.value) {
      if (isScalar(field.value) && Object.is(field.value.value, value)) continue;
      updated = replaceValue(updated, parsed.doc, field.value, value);
    } else {
      throw new Error(`无法用表单修改字段「${name}」。请编辑 YAML 原文件。`);
    }
  }
  entryPair(parse(updated).pairs, key);
  return updated;
}

export function addEntry(source: string, key: string, fields: Fields): string {
  const parsed = parse(source);
  if (parsed.entries.some((entry: BibliographyEntry): boolean =>
    entryCitationKeys(entry).some((name: string): boolean => name.normalize("NFC") === key.normalize("NFC")))) {
    throw new Error(`引用键「${key}」已存在。`);
  }
  const updated = appendPairs(source, parsed, parsed.mapping, { [key]: fields });
  entryPair(parse(updated).pairs, key);
  return updated;
}

export function removeEntry(source: string, key: string): string {
  const parsed = parse(source);
  const pair = entryPair(parsed.pairs, key);
  const start = pair.srcToken?.start.find((token: CST.SourceToken): boolean =>
    token.type === "explicit-key-ind" || token.type === "anchor" || token.type === "tag");
  let from = start?.offset ?? pair.key.range[0];
  const to = pair.value!.range[2];
  let updated: string;
  if (parsed.mapping?.srcToken?.type === "flow-collection") {
    const items = parsed.mapping.srcToken.items;
    const index = items.findIndex((item: CST.CollectionItem): boolean => item === pair.srcToken);
    const comma = items[index]?.start.find((token: CST.SourceToken): boolean => token.type === "comma");
    const nextComma = items[index + 1]?.start.find((token: CST.SourceToken): boolean => token.type === "comma");
    updated = replace(source, from, to, "");
    if (comma) updated = replace(updated, comma.offset, comma.offset + 1, "");
    else if (nextComma) {
      const offset = nextComma.offset - (to - from);
      updated = replace(updated, offset, offset + 1, "");
    }
  } else {
    const lineStart = source.lastIndexOf("\n", from - 1) + 1;
    // A document marker or BOM can be on the same line as the key.
    if (/^[ \t]*$/.test(source.slice(lineStart, from))) from = lineStart;
    updated = replace(source, from, to, "");
  }
  parse(updated);
  return updated;
}

export function renameEntry(source: string, from: string, to: string): string {
  const parsed = parse(source);
  const { key } = entryPair(parsed.pairs, from);
  const replacement = renderValue(parsed.doc, to, key);
  const updated = replace(source, key.range[0], key.range[1], replacement);
  entryPair(parse(updated).pairs, to);
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
  const parsed = parse(source);
  const edits: { node: ParsedNode; value: string }[] = [];
  const inspect = (
    nodes: unknown, fields: Fields, key: StringKey, version?: number,
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
      if (!node || (isScalar(node) && node.anchor)) {
        throw new Error(`条目「${key.value}」的 ${field} 使用共享 YAML 数据，请在原文件中核对并调整。`);
      }
      edits.push({ node, value: after });
    }
  };
  parsed.pairs.forEach((pair: EntryPair, index: number): void => {
    const { fields } = parsed.entries[index];
    inspect(pair.value, fields, pair.key);
    if (!Array.isArray(fields.versions)) return;
    const versions = pair.value?.get("versions", true);
    for (const [number, version] of fields.versions.entries()) {
      if (!version || typeof version !== "object" || Array.isArray(version)) continue;
      inspect(isSeq(versions) ? versions.items[number] : undefined, version, pair.key, number + 1);
    }
  });
  edits.sort((left: { node: ParsedNode }, right: { node: ParsedNode }): number => right.node.range[0] - left.node.range[0]);
  let result = source;
  for (const { node, value } of edits) result = replaceValue(result, parsed.doc, node, value);
  if (edits.length) parse(result);
  return result;
}
