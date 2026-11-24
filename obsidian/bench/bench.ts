import {
  analyzeWriting,
  type SourceAnalysisCache,
} from "../src/language/analysis";
import { toPublicationDocument } from "../src/project/publication";
import type { SourceFile } from "../src/project/types";
import { BrowserRendererClient } from "../src/preview/browser-renderer-client";

import { makeProject, edit } from "./fixture";
export async function benchmark(): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  for (const count of [1, 8, 32, 64]) {
    const project = makeProject(count);
    const cache: SourceAnalysisCache = new Map();
    const t0 = performance.now();
    analyzeWriting(project, cache);
    const cold = performance.now() - t0;
    const t1 = performance.now();
    analyzeWriting(project, cache);
    const warm = performance.now() - t1;
    const next = edit(project);
    const t2 = performance.now();
    const result = analyzeWriting(next, cache);
    const changed = performance.now() - t2;
    results.push({
      kind: "analysis",
      chapters: count,
      bytes: project.files.reduce(
        (n: number, f: SourceFile): number => n + Buffer.byteLength(f.text),
        0,
      ),
      coldMs: Math.round(cold),
      warmMs: Math.round(warm),
      oneChapterEditMs: Math.round(changed),
      diagnostics: result.analysis.diagnostics.length,
      hostRssMiB: Math.round(process.memoryUsage().rss / 1048576),
    });
    const client = new BrowserRendererClient();
    try {
      for (const [index, p] of [project, project, next].entries()) {
        const start = performance.now();
        const response = await client.render(
          {
            id: `${count}-${index}`,
            revision: p.revision,
            document: toPublicationDocument(p),
          },
          new AbortController().signal,
        );
        if ("error" in response) throw new Error(response.error.message);
        results.push({
          kind: "preview",
          chapters: count,
          round: index,
          ms: Math.round(performance.now() - start),
          htmlBytes: response.pages.reduce(
            (n: number, p: { html: string }): number =>
              n + Buffer.byteLength(p.html),
            0,
          ),
        });
      }
    } finally {
      await client.dispose();
    }
  }

  return results;
}
