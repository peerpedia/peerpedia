import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { nativeFiles } from "../scripts/native-files";
import { recoverProject } from "../src/project/recovery";
Object.assign(globalThis, { __PEERPEDIA_ANCHORED__: nativeFiles() });
const root = await realpath(
  await mkdtemp(join(tmpdir(), "peerpedia-recovery-audit-")),
);
try {
  const recovery = join(root, ".peerpedia-obsidian/recovery");
  await mkdir(recovery, { recursive: true });
  const before = "a".repeat(1024),
    after = "b".repeat(1024);
  const digest = createHash("sha256").update(before).digest("hex");
  let total = 0;
  for (const n of [100, 500, 1000, 2000]) {
    while (total < n) {
      const dir = join(recovery, randomUUID());
      await mkdir(dir);
      await writeFile(
        join(dir, "journal.json"),
        JSON.stringify({
          files: [
            {
              path: "main.md",
              beforeDigest: digest,
              beforeText: before,
              afterText: after,
            },
          ],
        }),
      );
      await writeFile(join(dir, "complete"), "ok\n");
      await writeFile(join(dir, "file-0"), before);
      total++;
    }
    await recoverProject(root);
    const start = performance.now();
    const result = await recoverProject(root);
    console.log(
      JSON.stringify({
        records: n,
        scanMs: Math.round(performance.now() - start),
        notices: result.length,
      }),
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
