declare module "*/editor/chapter-title.js" {
  export function publicationImage(source: string, node: import("@lezer/common").SyntaxNodeRef): {from: number; to: number} | undefined;
  export function inspectChapter(source: string): { title: string; images: boolean };
}

declare module "*/editor/dialect.js" {
  export const dialectOptions: object;
}

declare module "*/peerpedia-theme/scripts/embedded.mjs" {
  export function embeddedTheme(directory: string): Promise<object>;
}
