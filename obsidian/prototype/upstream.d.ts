declare module "*.mjs" {
  export function renderDocument(
    input: unknown,
  ): Promise<{ pages: { id: string; html: string }[]; targets: unknown[] }>;
}
