interface Edit { from: number; to: number; lines: string[] }
type Side = "local" | "remote";

function lines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}

function edits(original: string[], next: string[]): Edit[] {
  let start = 0, end = original.length, after = next.length;
  while (start < end && start < after && original[start] === next[start]) ++start;
  while (end > start && after > start && original[end-1] === next[after-1]) { --end; --after; }
  if (start === end && start === after) return [];
  const width = after - start + 1, height = end - start + 1;
  // Bound quadratic LCS work on large rewrites. A coarse edit can produce a
  // larger review hunk, while preserving the entire source on both sides.
  if (width * height > 2_000_000 || width === 1 || height === 1) return [{from:start,to:end,lines:next.slice(start,after)}];
  const lengths = new Uint32Array(width * height);
  for (let i = height-2; i >= 0; --i) {
    for (let j = width-2; j >= 0; --j) {
      const pos = i*width+j;
      lengths[pos] = original[start+i] === next[start+j] ? lengths[pos+width+1]+1 : Math.max(lengths[pos+1],lengths[pos+width]);
    }
  }
  const result: Edit[] = [];
  let i = start, j = start;
  while (i < end || j < after) {
    if (i < end && j < after && original[i] === next[j]) { ++i; ++j; continue; }
    const from = i, first = j;
    do {
      const pos = (i-start)*width+(j-start);
      if (j === after || (i < end && lengths[pos+width] >= lengths[pos+1])) ++i;
      else ++j;
    } while ((i < end || j < after) && !(i < end && j < after && original[i] === next[j]));
    result.push({from,to:i,lines:next.slice(first,j)});
  }
  return result;
}

export function mergeText(base: string, local: string, remote: string,
  conflict: (line: number, base: string, local: string, remote: string) => string): string {
  if (local === remote || remote === base) return local;
  if (local === base) return remote;
  const original = lines(base);
  type Change = Edit & {side: Side};
  const changes: Change[] = [];
  for (const side of ["local","remote"] as const) {
    for (const edit of edits(original,lines(side === "local" ? local : remote))) changes.push({...edit,side});
  }
  changes.sort((a: Change,b: Change): number => a.from-b.from || a.to-b.to);
  let cursor = 0, result = "";
  for (let i = 0; i < changes.length;) {
    const first = changes[i++], from = first.from, group = [first];
    let to = first.to;
    while (i < changes.length && (changes[i].from < to || (to === from && changes[i].from === from && changes[i].to === from))) {
      const next = changes[i++];
      group.push(next);
      to = Math.max(to,next.to);
    }
    result += original.slice(cursor,from).join("");
    const before = original.slice(from,to).join("");
    const sideText = (side: Side): string => {
      let at = from, value = "";
      for (const edit of group) if (edit.side === side) {
        value += original.slice(at,edit.from).join("") + edit.lines.join("");
        at = edit.to;
      }
      return value + original.slice(at,to).join("");
    };
    const left = sideText("local"), right = sideText("remote");
    result += left === right || right === before ? left : left === before ? right : conflict(from+1,before,left,right);
    cursor = to;
  }
  return result + original.slice(cursor).join("");
}
