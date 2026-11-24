export interface DocumentInput {
  pages?: readonly { id: string; title?: string; markdown: string }[];
  source?: string;
  bibliography?: string;
  reader?: string;
  prefix?: string;
  diagrams?: boolean;
  staticUrl?: string;
  numberSections?: boolean;
}
export interface RenderedDocument {
  pages: {
    id: string;
    title: string;
    html: string;
    headings: {
      id: string;
      level: number;
      label: string;
      title: boolean;
      number: string;
    }[];
  }[];
  targets: {
    id: string;
    chapter: string;
    kind: string;
    line?: number;
    [key: string]: unknown;
  }[];
  entries: Record<string, object>;
  warnings: string[];
}
export interface DiagramCompiler {
  render(html: string, options: object): Promise<string>;
  close(): Promise<void>;
}
export interface RenderPlatform {
  hash(source: string): string;
  createDiagrams?(options: object): DiagramCompiler;
  cacheDirectory?: string;
}
export interface DocumentRenderer {
  (input: DocumentInput): Promise<RenderedDocument>;
  (input: { action: "scan"; source?: string }): Promise<{ images: boolean }>;
}
export function createDocumentRenderer(
  platform: RenderPlatform,
): DocumentRenderer;
