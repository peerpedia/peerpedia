import { Buffer } from "buffer";
declare const __TEX_ASSETS__: string;
export interface CoreSnapshot {
  byteLength: number;
  restore(target: Uint8Array): void;
}
export async function loadAssets(encoded: string = __TEX_ASSETS__): Promise<{
  core: CoreSnapshot;
  wasm: Uint8Array;
  files: Record<string, Uint8Array>;
}> {
  const compressed = Uint8Array.from(Buffer.from(encoded, "base64"));
  const archive = Buffer.from(
    await new Response(
      new Blob([compressed])
        .stream()
        .pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );
  if (archive.length < 4) throw new Error("Truncated TeX resource archive.");
  const indexEnd = 4 + archive.readUInt32LE(0);
  if (indexEnd > archive.length)
    throw new Error("Truncated TeX resource index.");
  const {
    entries: index,
    coreLength,
    coreOffsets,
  }: {
    entries: [string, number][];
    coreLength: number;
    coreOffsets: number[];
  } = JSON.parse(archive.toString("utf8", 4, indexEnd));
  let offset = indexEnd;
  const assets: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  for (const [name, size] of index) {
    if (
      typeof name !== "string" ||
      Object.hasOwn(assets, name) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > archive.length - offset
    ) {
      throw new Error("Invalid TeX resource entry.");
    }
    // Binary resource views share one archive allocation.
    assets[name] = archive.subarray(offset, offset + size);
    offset += size;
  }
  const { core, wasm, ...files } = assets;
  if (offset !== archive.length || !core || !wasm?.byteLength) {
    throw new Error("Incomplete TeX resource archive.");
  }
  if (
    !Number.isSafeInteger(coreLength) ||
    coreLength <= 0 ||
    !Array.isArray(coreOffsets)
  )
    throw new Error("Invalid TeX snapshot length.");
  let packedLength = 0;
  let previous = -1;
  for (const page of coreOffsets) {
    if (
      !Number.isSafeInteger(page) ||
      page % 65536 !== 0 ||
      page <= previous ||
      page >= coreLength
    )
      throw new Error("Invalid TeX snapshot page.");
    packedLength += Math.min(65536, coreLength - page);
    previous = page;
  }
  if (packedLength !== core.byteLength)
    throw new Error("Invalid TeX snapshot data.");
  return {
    core: {
      byteLength: coreLength,
      restore(target: Uint8Array): void {
        if (target.byteLength !== coreLength)
          throw new Error("Incorrect TeX memory size.");
        target.fill(0);
        let packedOffset = 0;
        for (const page of coreOffsets) {
          const size = Math.min(65536, coreLength - page);
          target.set(core.subarray(packedOffset, packedOffset + size), page);
          packedOffset += size;
        }
      },
    },
    wasm,
    files,
  };
}
