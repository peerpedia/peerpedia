import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { referenceStop } from "bananamark/internal/scan.mjs";
import { escaped } from "bananamark/scan";
import { fencesBalance, inFormula, matchingEnd } from "bananamark-codemirror";
import katexCommands from "bananamark-codemirror/katex-commands.json";

import type { ProjectAnalysis } from "./analysis";
import { completionState, dialect, fenceLanguage, isValidLabel, literalAt, type LabelTarget } from "./index";

export interface CompletionContext {
  path: string;
  source: string;
  offset: number;
  explicit: boolean;
  composing: boolean;
}

export interface Suggestion {
  label: string;
  from: number;
  to: number;
  insertText: string;
  cursorOffset: number;
}

const environmentPrefix = /^([ \t]*(?:>[ \t]*)*)(:{3,})([ \t]*)([\w-]*)(?:[ \t]+(.*))?$/;
const blockPrefix = /^([ \t]*(?:>[ \t]*)*)(`{3,}|~{3,})([\w-]*)$/;
const texPrefix = /(?:\\begin\{[a-zA-Z*]*|\\[a-zA-Z]+)$/;
const referencePrefix = /(?:\{@|(?<![\p{L}\p{N}_@./%+\\])@)[^\s#@{}<>[\]|\\`()，。．；：！？、‘’“”（）［］｛｝【】「」『』]*$/u;

type Trigger = "environment" | "block" | "formula" | "reference";

export function completionTrigger(before: string, explicit: boolean): Trigger | null {
  if (blockPrefix.test(before)) return "block";
  if (texPrefix.test(before)) return "formula";
  const environment = environmentPrefix.exec(before);
  if (environment && !environment[5]?.includes("[") && (environment[4] || explicit)) return "environment";
  return referencePrefix.test(before) ? "reference" : null;
}

function environments(before: string, after: string, context: CompletionContext): Suggestion[] {
  const match = environmentPrefix.exec(before);
  if (!match) return [];
  const [, indent, fence, spacing, prefix, shorthand = ""] = match;
  if ((!prefix && !context.explicit) || /^[\w*-]/.test(after)) return [];
  if (shorthand && after.trim()) return [];
  const parsed = /^(.*?)\s*(?:\{?@([^\s{}]*)\}?)?$/.exec(shorthand.trim());
  const title = parsed?.[1].replace(/^\[(.*)\]$/, "$1").trim();
  const key = parsed?.[2];
  const names = Object.keys(dialect.environments).filter((name: string): boolean =>
    name.startsWith(prefix) && (name !== prefix || Boolean(shorthand) || context.explicit));
  const from = context.offset - before.length + indent.length;
  const hasClosing = fencesBalance(context.source);
  return names.map((name: string): Suggestion => {
    const label = `::: ${name}`;
    if (after.trim()) {
      const insertText = fence + spacing + name;
      return { label, from, to: context.offset, insertText, cursorOffset: insertText.length };
    }
    const header = `${fence} ${name}${title ? ` [${title}]` : ""}${key ? ` {@${key}}` : ""}`;
    const to = context.offset + after.length;
    if (hasClosing) return { label, from, to, insertText: header, cursorOffset: header.length };
    return { label, from, to, insertText: `${header}\n${indent}\n${indent}${fence}`, cursorOffset: header.length + indent.length + 1 };
  });
}

function blocks(before: string, after: string, context: CompletionContext, node: SyntaxNode | null): Suggestion[] {
  const match = blockPrefix.exec(before);
  if (!match || after.trim()) return [];
  const [, indent, fence, prefix] = match;
  const from = context.offset - before.length + indent.length;
  if (node && (node.name !== "FencedCode" || node.from !== from)) return [];
  // A bare fence can be a closing fence. In the independent grammar, an
  // actual closing fence belongs to the opening node above, not to this line.
  if (!prefix && !context.explicit) return [];
  const kinds = ["math", ...(dialect.tikz ? ["tikz"] : []), ...Object.keys(dialect.dataBlocks),
    ...(dialect.bibliography ? ["bibliography"] : [])];
  const hasClosing = node?.lastChild?.name === "CodeMark" && node.lastChild.from > from;
  return kinds.filter((name: string): boolean => name.startsWith(prefix) && name !== prefix)
    .map((name: string): Suggestion => {
      const head = fence + name;
      return {
        label: head, from, to: context.offset + after.length,
        insertText: hasClosing ? head : `${head}\n${indent}\n${indent}${fence}`,
        cursorOffset: head.length + (hasClosing ? 0 : indent.length + 1),
      };
    });
}

function texEnvironment(
  state: EditorState, source: string, name: string, args: number, indent: string, from: number, to: number,
): Suggestion {
  const label = `\\begin{${name}}`;
  const close = `\\end{${name}}`;
  const existing = matchingEnd(state, from, to);
  if (existing) {
    return {
      label, from, to: existing.to,
      insertText: label + source.slice(to, existing.from) + close,
      cursorOffset: label.length,
    };
  }
  const head = label + "{}".repeat(args);
  return {
    label, from, to,
    insertText: `${head}\n${indent}  \n${indent}${close}`,
    cursorOffset: args ? label.length + 1 : head.length + indent.length + 3,
  };
}

function formulas(before: string, after: string, context: CompletionContext, state: EditorState): Suggestion[] {
  const match = texPrefix.exec(before);
  const from = context.offset - (match?.[0].length ?? 0);
  if (!match || escaped(context.source, from)) return [];
  const prefix = match[0];
  const environment = prefix.startsWith("\\begin{");
  if (environment ? /^[^}\s]/.test(after) : /^[a-zA-Z]/.test(after)) return [];
  const indent = /^[ \t>]*/.exec(before)?.[0] ?? "";
  const suggestions = katexCommands.environments
    .filter(([name]: readonly [string, number]): boolean => `\\begin{${name}`.startsWith(prefix))
    .map(([name, args]: readonly [string, number]): Suggestion =>
      texEnvironment(state, context.source, name, args, indent, from, context.offset + Number(environment && after.startsWith("}"))));
  if (environment) return suggestions;
  const commands = katexCommands.commands.filter(([name]: readonly [string, number, string?]): boolean => name.startsWith(prefix) && name !== prefix);
  return [
    ...commands.map(([label, args]: readonly [string, number, string?]): Suggestion => {
      const hasArgs = after.startsWith("{");
      const insertText = label + (hasArgs ? "" : "{}".repeat(args));
      return { label, from, to: context.offset, insertText, cursorOffset: label.length + Number(args > 0 && !hasArgs) };
    }),
    ...suggestions,
  ];
}

function references(before: string, after: string, context: CompletionContext, analysis: ProjectAnalysis): Suggestion[] {
  const match = referencePrefix.exec(before);
  if (!match || escaped(context.source, context.offset - match[0].length)) return [];
  const braced = match[0].startsWith("{@");
  const beforeKey = match[0].slice(braced ? 2 : 1);
  const numberOnly = beforeKey.startsWith("-") && !before.slice(0, match.index).endsWith("](");
  const prefix = beforeKey.slice(Number(numberOnly)).normalize("NFC");
  if (!prefix && !braced && !context.explicit && !before.endsWith("@")) return [];
  const from = context.offset - beforeKey.length + Number(numberOnly);
  const suffix = after.search(referenceStop);
  const to = context.offset + (suffix === -1 ? after.length : suffix);
  // Trailing punctuation belongs to running text, not to the label.
  let end = to;
  if (!braced) {
    while (end > context.offset && /[,.;:'"!?–—-]/.test(context.source[end - 1])) end--;
  }
  const counts = new Map<string, number>();
  for (const label of analysis.labels) counts.set(label.key, (counts.get(label.key) ?? 0) + 1);
  return analysis.labels
    .filter((item: LabelTarget): boolean => counts.get(item.key) === 1 && isValidLabel(item.key)
      && item.key.startsWith(prefix) && (!numberOnly || item.kind !== "bibliography"))
    .sort((left: LabelTarget, right: LabelTarget): number =>
      Number(right.path === context.path) - Number(left.path === context.path) || left.key.localeCompare(right.key))
    .map((item: LabelTarget): Suggestion => {
      const insertText = item.label + (braced && context.source[end] !== "}" ? "}" : "");
      return { label: item.label, from, to: end, insertText, cursorOffset: insertText.length };
    });
}

export function suggestionsFor(context: CompletionContext, analysis: ProjectAnalysis): readonly Suggestion[] {
  const { source, offset, explicit, composing } = context;
  if (composing || !Number.isInteger(offset) || offset < 0 || offset > source.length) return [];
  const start = offset === 0 ? 0 : source.lastIndexOf("\n", offset - 1) + 1;
  const end = source.indexOf("\n", offset);
  const before = source.slice(start, offset);
  const trigger = completionTrigger(before, explicit);
  if (!trigger) return [];
  const after = source.slice(offset, end < 0 ? source.length : end);
  const state = completionState(source);
  const literal = literalAt(syntaxTree(state), offset);

  if (trigger === "block") return blocks(before, after, context, literal);
  if (literal && (literal.name !== "FencedCode" || !/^(?:math|tikz|latex|tex)$/.test(fenceLanguage(source, literal) ?? ""))) return [];
  if (trigger === "formula" && inFormula(state, offset)) return formulas(before, after, context, state);
  if (literal || inFormula(state, offset)) return [];
  if (trigger === "environment") return environments(before, after, context);
  return references(before, after, context, analysis);
}

export async function complete(context: CompletionContext, analysis: ProjectAnalysis): Promise<readonly Suggestion[]> {
  return suggestionsFor(context, analysis);
}
