declare module "*/site/render-document.mjs" {
  interface SitePage {
    id: string;
    title?: string;
    markdown: string;
  }

  interface SiteInput {
    pages: readonly SitePage[];
    bibliography: string;
    numberSections: boolean;
    diagrams: boolean;
    staticUrl: string;
  }

  export interface SiteHeading {
    id: string;
    level: number;
  }

  export interface SiteTarget {
    id: string;
    chapter: string;
    kind: string;
    line?: number;
  }

  export function renderDocument(input: SiteInput): Promise<{
    pages: readonly { id: string; title: string; html: string; headings: readonly SiteHeading[] }[];
    targets: readonly SiteTarget[];
  }>;
}

declare module "*/site/dialect.js" {
  export const dialectOptions: object;
}

declare module "bananamark" {
  export type SyntaxNodeRef = import("@lezer/common").SyntaxNodeRef;

  export function defineDialect(options: object): {
    language: { language: { parser: { parse(source: string): {
      iterate(options: { enter: (node: SyntaxNodeRef) => void }): void;
    } } } };
  };
}
