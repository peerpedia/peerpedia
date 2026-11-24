import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function cacheArchive(cached: string, digest: string, download: (path: string) => Promise<void>): Promise<string> {
  const folder = dirname(cached);
  await mkdir(folder, { recursive: true });
  try {
    if (await sha256(cached) === digest) return cached;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await mkdtemp(join(folder, ".renderer-download-"));
  try {
    const archive = join(staging, basename(cached));
    await download(archive);
    if (await sha256(archive) !== digest) throw new Error("Node.js archive SHA-256 did not match the pinned release.");
    // Publish the verified inode in one rename on the cache filesystem.
    await rename(archive, cached);
    return cached;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
