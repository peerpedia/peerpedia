const THEOREM = "theorem";

export function probeCompletions(
  source: string,
  offset: number,
  composing: boolean,
): readonly string[] {
  if (composing || !Number.isInteger(offset) || offset <= 0 || offset > source.length) {
    return [];
  }

  if (/[\w-]/.test(source.charAt(offset))) {
    return [];
  }

  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const prefix = /^[ \t]*:::([a-z]+)$/.exec(source.slice(lineStart, offset))?.[1];
  return prefix && THEOREM.startsWith(prefix) && prefix !== THEOREM ? [THEOREM] : [];
}
