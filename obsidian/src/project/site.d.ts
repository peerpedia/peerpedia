declare module "*/editor/chapter-title.js" {
  export function inspectChapter(source: string): { title: string; images: boolean };
}

declare module "*/editor/dialect.js" {
  export const dialectOptions: object;
}
