import {mkdtemp, open, readdir, rm, symlink, truncate, utimes, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, test} from "vitest";
import {pruneDiagramCache} from "../renderer/tikz-cache";

test("concurrent pruning retains the 256 newest cache results and leaves unrelated entries alone", async (): Promise<void> => {
  const cache = await mkdtemp(join(tmpdir(), "peerpedia-cache-test-"));
  try {
    for (let i = 0; i < 260; ++i) {
      const name = join(cache, i.toString(16).padStart(64,"0") + ".json");
      await writeFile(name, "{}");
      const at = new Date(1700000000000 + i * 1000);
      await utimes(name, at, at);
    }
    await writeFile(join(cache, "settings.json"), "keep");
    const link = "f".repeat(64) + ".json";
    await symlink("settings.json", join(cache, link));
    await Promise.all([pruneDiagramCache(cache), pruneDiagramCache(cache)]);
    const names = await readdir(cache);
    expect(names).toHaveLength(258);
    expect(names).toContain("settings.json");
    expect(names).toContain(link);
    expect(names).toContain((259).toString(16).padStart(64,"0") + ".json");
    expect(names).not.toContain("0".repeat(64) + ".json");
    const huge = join(cache, "e".repeat(64) + ".json");
    await writeFile(huge, "{}");
    await truncate(huge, 64 * 1024 * 1024 + 1);
    const active = await open(huge, "r");
    try {
      await pruneDiagramCache(cache);
      expect(await readdir(cache)).not.toContain("e".repeat(64) + ".json");
      const head = Buffer.alloc(2);
      await active.read(head, 0, 2, 0);
      expect(head.toString()).toBe("{}");
    } finally { await active.close(); }
  } finally { await rm(cache, {recursive:true,force:true}); }
});
