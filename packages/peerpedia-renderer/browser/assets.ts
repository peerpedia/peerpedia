import { Buffer } from "buffer";
declare const __TEX_ASSETS__: string;
export async function loadAssets(): Promise<{
  core: Uint8Array;
  wasm: Uint8Array;
  files: Record<string, string>;
}> {
  const bytes = Uint8Array.from(atob(__TEX_ASSETS__), (ch: string): number =>
    ch.charCodeAt(0),
  );
  const decoded = await new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
  const source: { core: string; wasm: string; files: Record<string, string> } =
    JSON.parse(decoded);
  return {
    core: Buffer.from(source.core, "base64"),
    wasm: Buffer.from(source.wasm, "base64"),
    files: source.files,
  };
}
