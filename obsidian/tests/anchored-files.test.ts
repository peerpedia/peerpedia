import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { AnchoredFiles } from "../src/project/anchored-files";

test.each(["directory", "symlink"])("a replaced pinned parent aborts publication without changing either directory (%s)", async (kind: string): Promise<void> => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "paper-anchors-")));
  try {
    await fs.mkdir(join(base, "paper"));
    await fs.mkdir(join(base, "other"));
    await fs.writeFile(join(base, "other/guard.md"), "other original");
    await fs.writeFile(join(base, "paper/guard.md"), "original manuscript");
    const tree = AnchoredFiles.open(base);
    try {
      await tree.file("incoming", "proposed");
      tree.directory("paper");
      await fs.rename(join(base, "paper"), join(base, "old"));
      if (kind === "directory") await fs.rename(join(base, "other"), join(base, "paper"));
      else await fs.symlink(join(base, "other"), join(base, "paper"));
      expect((): void => tree.rename("incoming", "paper/guard.md", "swap")).toThrow();
      expect(await fs.readFile(join(base, "paper/guard.md"), "utf8")).toBe("other original");
      expect(await fs.readFile(join(base, "old/guard.md"), "utf8")).toBe("original manuscript");
    } finally { tree.close(); }
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("a redirected journal directory cannot receive private before/after images", async (): Promise<void> => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "paper-journal-pin-")));
  const tree = AnchoredFiles.open(base);
  try {
    await tree.directories("paper/.peerpedia-obsidian/recovery");
    const journal = "paper/.peerpedia-obsidian/recovery/record";
    await tree.mkdir(journal);
    await fs.mkdir(join(base, "replacement"));
    await fs.rename(join(base, journal), join(base, "saved-record"));
    await fs.symlink(join(base, "replacement"), join(base, journal));
    await expect(tree.file(journal + "/journal.json", "private image")).rejects.toThrow();
    expect(await fs.readdir(join(base, "replacement"))).toEqual([]);
  } finally { tree.close(); await fs.rm(base, { recursive: true, force: true }); }
});

test("closing prevents delayed callbacks from using released or reused directory descriptors", async (): Promise<void> => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "paper-fd-lifetime-")));
  const tree = AnchoredFiles.open(base);
  try {
    await tree.file("stage", "ready");
    const announce = tree.publicationSignal("stage", "live");
    tree.rename("stage", "live", "publish");
    const pending = tree.sync(".");
    tree.close();
    expect(announce).toThrow(/已结束/);
    await pending;
    await expect(tree.file("unexpected", "late")).rejects.toThrow(/已结束/);
    expect(await fs.readdir(base)).toEqual(["live"]);
  } finally { tree.close(); await fs.rm(base, { recursive: true, force: true }); }
});

test("asking the host to observe publication preserves content and mtime and verifies the published inode", async (): Promise<void> => {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "paper-publish-signal-")));
  const tree = AnchoredFiles.open(base);
  try {
    await tree.file("stage", "已发布");
    const signal = tree.publicationSignal("stage", "live");
    tree.rename("stage", "live", "publish");
    const before = await fs.stat(join(base, "live"), { bigint: true });
    signal();
    expect((await fs.stat(join(base, "live"), { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    expect(await fs.readFile(join(base, "live"), "utf8")).toBe("已发布");
    await fs.rename(join(base, "live"), join(base, "saved"));
    await fs.writeFile(join(base, "live"), "other");
    expect(signal).toThrow(/已改变/);
  } finally { tree.close(); await fs.rm(base, { recursive: true, force: true }); }
});
