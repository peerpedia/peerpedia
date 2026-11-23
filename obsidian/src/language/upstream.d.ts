declare module "bananamark-codemirror" {
  type EditorState = import("@codemirror/state").EditorState;
  type Text = import("@codemirror/state").Text;

  export interface Problem {
    line: number;
    column?: number;
    message: string;
    code?: string;
  }

  export function declaredLabels(source: string, options?: { bibliography?: boolean }): { name: string; text: string }[];
  export function inFormula(state: EditorState, pos: number): boolean;
  export function matchingEnd(state: EditorState, from: number, to: number): { from: number; to: number } | null;
  export function checkDocument(source: string, options: {
    dialect: ReturnType<typeof import("bananamark").defineDialect>;
    labels?: readonly { name: string; text: string; page: string }[];
    key?: string;
  }): Problem[];
  export function problemRange(doc: Text, lineNumber: number, column?: number): { from: number; to: number };
}

declare module "bananamark-codemirror/katex-commands.json" {
  const data: {
    commands: readonly (readonly [name: string, args: number, glyph?: string])[];
    environments: readonly (readonly [name: string, args: number])[];
  };
  export default data;
}

declare module "bananamark/scan" {
  export const labelledMarkerSource: string;
  export function fenceMarker(line: string): string | undefined;
  export function closesFence(marker: string | undefined, open: string): boolean;
  export function escaped(source: string, offset: number): boolean;
}

declare module "bananamark/internal/scan.mjs" {
  export const referenceStop: RegExp;
  export function validReferenceName(value: string): boolean;
}

declare module "bananamark/internal/lists.mjs" {
  export function parseLists(source: string): { items: readonly { id: string; start: number; end: number }[] };
}

declare module "bananamark/internal/markup.mjs" {
  export function readReference(source: string, from: number, options?: { ignoreEscape: boolean }): { end: number; key?: string } | undefined;
  export function readMarkdownLink(source: string, from: number): { end: number; reference?: string } | undefined;
  export function transformMarkup(source: string, extensions: readonly unknown[], options: {
    indentedCode: boolean;
    resolveReference(key: string, from: number, label?: string): { label: string; node: object };
  }): string;
}

declare module "bananamark/internal/nodes.mjs" {
  export function withNodes<T>(nodes: unknown[], action: () => T): T;
}

declare module "bananamark/internal/switches.mjs" {
  export function withSyntax<T>(options: { tikz: boolean }, action: () => T): T;
}
