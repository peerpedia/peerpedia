import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tikz } from "bananamark-tikz";

const week = 7 * 24 * 3600 * 1000;

export async function pruneCache({
  cache = process.env.BANANAMARK_CACHE,
  maxBytes = Number(process.env.BANANAMARK_CACHE_BYTES || 1024 * 1024 * 1024),
  maxAge = week,
} = {}) {
  if (!cache) return { files: 0, bytes: 0, removed: 0 };
  if (!Number.isFinite(maxBytes) || maxBytes <= 0)
    throw new Error("Invalid cache capacity.");
  const diagrams = tikz({ cache });
  let removed = 0;
  const usage = async () => {
    const files = (
      await readdir(cache).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })
    ).filter((name) => name.endsWith(".json"));
    const sizes = await Promise.all(
      files.map(async (name) => (await stat(join(cache, name))).size),
    );
    return { files: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0) };
  };
  try {
    removed += await diagrams.prune({ maxAge });
    let size = await usage();
    // Prefer older entries; this is a disposable compilation cache. Reading
    // copies already contain their SVG and never depend on these cache files.
    while (size.bytes > maxBytes) {
      maxAge = maxAge < 1000 ? 0 : Math.floor(maxAge / 2);
      removed += await diagrams.prune({ maxAge });
      size = await usage();
      if (maxAge === 0) break;
    }
    return { ...size, removed };
  } finally {
    await diagrams.close();
  }
}
