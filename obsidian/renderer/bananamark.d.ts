declare module "bananamark" {
  export type SyntaxNodeRef = import("@lezer/common").SyntaxNodeRef;

  export class BananamarkError extends Error {}

  export function transformFragment(
    source: string,
    options: { dialect: ReturnType<typeof defineDialect> },
  ): { nodes: readonly { type: string; tex?: string }[] };

  export function defineDialect(options: object): {
    language: import("@codemirror/language").LanguageSupport;
    environments: Readonly<Record<string, unknown>>;
    dataBlocks: Readonly<Record<string, unknown>>;
    bibliography: boolean;
    tikz: boolean;
  };
}
