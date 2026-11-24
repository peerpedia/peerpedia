import { createHash } from "node:crypto";
import { readFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { expect, test } from "vitest";

import { cacheArchive } from "../scripts/renderer-archive";

test("concurrent cold-cache builders publish only a verified archive inode", async (): Promise<void> => {
  const folder = await mkdtemp(join(tmpdir(), "peerpedia-node-cache-"));
  const archive = join(folder, "node.tar.gz");
  const bytes = "a fixture for the verified download";
  const digest = createHash("sha256").update(bytes).digest("hex");
  let firstInode: bigint | undefined;
  let secondInode: bigint | undefined;
  try {
    const path = await cacheArchive(archive, digest, async (first: string): Promise<void> => {
      await writeFile(first, bytes);
      firstInode = (await stat(first, { bigint: true })).ino;
      expect(dirname(dirname(first))).toBe(folder);
      await expect(readFile(archive)).rejects.toMatchObject({ code: "ENOENT" });
      const published = await cacheArchive(archive, digest, async (second: string): Promise<void> => {
        await writeFile(second, bytes);
        secondInode = (await stat(second, { bigint: true })).ino;
      });
      expect(await readFile(published, "utf8")).toBe(bytes);
      expect((await stat(published, { bigint: true })).ino).toBe(secondInode);
    });
    expect(path).toBe(archive);
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect([firstInode, secondInode]).toContain((await stat(path, { bigint: true })).ino);
    expect(await readdir(folder)).toEqual(["node.tar.gz"]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("a failed cold download leaves no archive or staging files", async (): Promise<void> => {
  const folder = await mkdtemp(join(tmpdir(), "peerpedia-node-cache-"));
  const cache = join(folder, "downloads");
  const archive = join(cache, "node.tar.gz");
  const digest = createHash("sha256").update("complete").digest("hex");
  try {
    await mkdir(cache);
    await expect(cacheArchive(archive, digest, async (path: string): Promise<void> => {
      await writeFile(path, "incomplete");
    })).rejects.toThrow(/SHA-256/);
    expect(await readdir(cache)).toEqual([]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
