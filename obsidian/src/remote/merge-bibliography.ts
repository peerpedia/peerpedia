import { isDeepStrictEqual as equal } from "node:util";
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from "yaml";
import { readEntries } from "../bibliography/document";
import { mergeText } from "./merge-text";

interface Parts { header: string; entries: Map<string,string> }
type Conflict = (target: string, base: string|null, local: string|null, remote: string|null) => string|null;

function parts(source: string): Parts {
  readEntries(source);
  const doc = parseDocument(source);
  const entries = new Map<string,string>();
  if (doc.contents === null) return {header:source,entries};
  if (!isMap(doc.contents) || doc.contents.flow || doc.directives.docStart || doc.directives.docEnd) throw new Error();
  visit(doc, (_key: unknown,node: unknown): void => {
    if (isAlias(node) || (isNode(node) && (node.tag || ("anchor" in node && node.anchor)))) throw new Error();
  });
  const items = doc.contents.items;
  let header = source;
  for (let i = 0; i < items.length; ++i) {
    const key = items[i].key, next = items[i+1]?.key;
    if (!isScalar(key) || !key.range || typeof key.value !== "string") throw new Error();
    const from = key.range[0], to = next?.range?.[0] ?? source.length;
    if (from > 0 && source[from-1] !== "\n") throw new Error();
    if (i === 0) header = source.slice(0,from);
    entries.set(key.value,source.slice(from,to));
  }
  return {header,entries};
}

// Verify the independent field edits survived the raw-text splice. In
// particular a changed indentation or a nested shared value cannot quietly
// change the interpretation of a different field.
function safeFields(key: string, raw: string, before: string, left: string, right: string): boolean {
  const fields = [raw,before,left,right].map((source: string): Readonly<Record<string,unknown>> => {
    const entries = readEntries(source);
    if (entries.length !== 1 || entries[0].key !== key) throw new Error();
    return entries[0].fields;
  });
  const [merged,base,local,remote] = fields;
  for (const name of new Set(fields.flatMap((row: Readonly<Record<string,unknown>>): string[] => Object.keys(row)))) {
    const b = base[name], l = local[name], r = remote[name];
    if (!equal(l,r) && !equal(l,b) && !equal(r,b)) return false;
    if (!equal(merged[name],equal(l,b) ? r : l)) return false;
  }
  return true;
}

export function mergeBibliography(base: string, local: string, remote: string, conflict: Conflict): string {
  if (local === remote || remote === base) return local;
  if (local === base) return remote;
  let parsed: Parts[];
  try { parsed = [base,local,remote].map(parts); }
  catch { return conflict("书目 YAML",base,local,remote) ?? ""; }
  const [b,l,r] = parsed;
  // When both sides change a bibliography and an existing key moves, show
  // the whole source, including the comments surrounding the move.
  for (const side of [l,r]) {
    if (!equal([...side.entries.keys()].filter((k: string): boolean => b.entries.has(k)),
      [...b.entries.keys()].filter((k: string): boolean => side.entries.has(k)))) return conflict("书目 YAML",base,local,remote) ?? "";
  }
  let result = mergeText(b.header,l.header,r.header,(line: number, old: string, a: string, z: string): string =>
    conflict("书目开头 · " + line,old,a,z) ?? "");
  const order = [...l.entries.keys()];
  for (const side of [r,b]) {
    const keys = [...side.entries.keys()];
    for (const [i,key] of keys.entries()) if (!order.includes(key)) {
      const next = keys.slice(i+1).find((k: string): boolean => order.includes(k));
      order.splice(next === undefined ? order.length : order.indexOf(next),0,key);
    }
  }
  for (const key of order) {
    const before = b.entries.get(key) ?? null, left = l.entries.get(key) ?? null, right = r.entries.get(key) ?? null;
    let value: string|null;
    if (left === right || right === before) value = left;
    else if (left === before) value = right;
    else {
      let automatic: string|undefined;
      if (before !== null && left !== null && right !== null) {
        try {
          const raw = mergeText(before,left,right,(): never => { throw new Error(); });
          if (safeFields(key,raw,before,left,right)) automatic = raw;
        } catch { /* Keep all three exact entries for manual resolution. */ }
      }
      value = automatic ?? conflict("书目条目 " + key,before,left,right);
    }
    if (!value) continue;
    if (result && !/[\n\r]$/.test(result)) result += /\r\n/.test(value) ? "\r\n" : "\n";
    result += value;
  }
  readEntries(result);
  return result;
}
