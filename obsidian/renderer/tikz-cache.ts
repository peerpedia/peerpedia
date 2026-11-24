import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

// BananaMark stores SHA-256-keyed JSON results in this renderer's dedicated directory.
// Cache reads tolerate a miss and active compiles already own their result in memory.
export async function pruneDiagramCache(directory: string): Promise<void> {
  const entries = [];
  for (const item of await readdir(directory, {withFileTypes: true}).catch((error: NodeJS.ErrnoException): [] => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    if (!item.isFile() || !/^[a-f0-9]{64}\.json$/.test(item.name)) continue;
    const path = join(directory, item.name);
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException): undefined => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (stat?.isFile()) entries.push({path, stat});
  }
  type Entry = (typeof entries)[number];
  entries.sort((a: Entry, b: Entry): number => b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path));
  let bytes = 0, count = 0;
  for (const {path, stat} of entries) {
    if (count < 256 && bytes + stat.size <= 64 * 1024 * 1024) { count++; bytes += stat.size; continue; }
    // Another preview may have touched, replaced or already evicted this file.
    try {
      const current = await lstat(path);
      if (current.isFile() && current.ino === stat.ino && current.ctimeMs === stat.ctimeMs) await unlink(path);
    } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
