import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { beforeAll, expect, test } from "vitest";

import { LanguageWorker, type LanguageThread } from "../src/host/language-worker";
import type { WritingAnalysis } from "../src/language/analysis";
import type { LanguageRequest, LanguageResponse } from "../src/language/worker-protocol";
import { editFixture, projectFixture } from "./fixtures";

let bundled: string;

beforeAll(async (): Promise<void> => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../src/language/worker.ts", import.meta.url))],
    bundle: true, platform: "browser", format: "iife", write: false, minify: true,
  });
  bundled = result.outputFiles[0].text;
});

function nodeThread(source: string): LanguageThread {
  // Supply the browser message surface to the production worker bundle in Vitest.
  const bootstrap = `
    const { parentPort } = require("node:worker_threads");
    /** @param {string} type @param {(event: {data: unknown}) => void} receive @returns {void} */
    globalThis.addEventListener = (type, receive) => {
      if (type === "message") parentPort.on("message", /** @param {unknown} data @returns {void} */ data => receive({ data }));
    };
    /** @param {unknown} data @returns {void} */
    globalThis.postMessage = data => parentPort.postMessage(data);
  `;
  const worker = new Worker(bootstrap + source, { eval: true });
  return {
    onResponse(listener: (response: LanguageResponse) => void): void {
      worker.on("message", listener);
    },
    onFailure(listener: (error: Error) => void): void {
      worker.on("error", listener);
      worker.on("exit", (code: number): void => listener(new Error(`Worker exited (${code})`)));
    },
    request(message: LanguageRequest): void {
      worker.postMessage(message);
    },
    close(): void {
      void worker.terminate();
    },
  };
}

test("a large chapter's analysis yields the calling event loop and preserves its revision", async (): Promise<void> => {
  const paragraph = "A typical paragraph for a large, valid mathematical paper. This sentence has no unusual notation.\n\n";
  const source = ("# Large valid chapter\n\n" + paragraph.repeat(9000)).slice(0, 762000);
  const project = editFixture(projectFixture(), "chapters/z-intro.md", source);
  const worker = new LanguageWorker(bundled, nodeThread);
  try {
    const analysis = worker.run("analyze", project);
    const first = await Promise.race([
      analysis.then((_result: WritingAnalysis): string => "analysis"),
      new Promise<string>((resolve: (value: string) => void): void => {
        setTimeout((): void => resolve("input timer"), 15);
      }),
    ]);
    expect(first).toBe("input timer");
    const result = await analysis;
    expect(result.analysis.revision).toBe(project.revision);
    expect(result.analysis.diagnostics).toEqual([]);
  } finally {
    worker.dispose();
  }
});

test("reports a worker crash and rejects further work promptly on disposal", async (): Promise<void> => {
  const worker = new LanguageWorker('throw new Error("worker startup failed")', nodeThread);
  try {
    await expect(worker.run("analyze", projectFixture())).rejects.toThrow("worker startup failed");
    // Startup errors clear the worker, so the next edit can start a fresh one.
    await expect(worker.run("analyze", projectFixture())).rejects.toThrow("worker startup failed");
  } finally {
    worker.dispose();
  }
  await expect(worker.run("analyze", projectFixture())).rejects.toThrow("worker is closed");
});

test("disposal rejects an in-flight request rather than leaving it pending", async (): Promise<void> => {
  const worker = new LanguageWorker(bundled, nodeThread);
  const result = worker.run("analyze", projectFixture());
  worker.dispose();
  await expect(result).rejects.toThrow("worker is closed");
});

test.each(["[[My note]]", "![image](figure.png)"])("bibliography commands preserve %s and its publication diagnostic", async (markup: string): Promise<void> => {
  const path = "chapters/z-intro.md";
  const source = "See @example and " + markup + ".\n";
  const project = editFixture(projectFixture(), path, source);
  const worker = new LanguageWorker(bundled, nodeThread);
  try {
    expect((await worker.run("analyze", project)).analysis.diagnostics).toContainEqual(
      expect.objectContaining({path, from: source.indexOf(markup), message: expect.stringMatching(/Image embeds|Obsidian/) }));
    await expect(worker.run("validateCitationKey", {project, key: "fresh"})).resolves.toBeUndefined();
    expect(await worker.run("citationImpact", {project, key: "example"})).toContainEqual(
      expect.objectContaining({path, key: "example", line: 1}));
    expect((await worker.run("citationRename", {project, from: "example", to: "fresh"})).changes).toContainEqual(
      expect.objectContaining({path, afterText: source.replace("@example", "@fresh")}));
  } finally {
    worker.dispose();
  }
});

test.each(["entry: [broken", "*missing", "entry: *missing", "entry: {versions: *missing}"])(
  "unreadable inline YAML blocks all three bibliography commands: %s", async (yaml: string): Promise<void> => {
  const path = "chapters/z-intro.md";
  const source = "~~~bibliography\n" + yaml + "\n~~~\n";
  const project = editFixture(projectFixture(), path, source);
  const worker = new LanguageWorker(bundled, nodeThread);
  try {
    if (yaml.includes("*missing")) {
      expect((await worker.run("analyze", project)).analysis.diagnostics).toContainEqual(
        expect.objectContaining({path, from:source.indexOf(yaml), to:source.indexOf("\n~~~") + 1, code:"bibliography-yaml"}));
    }
    await expect(worker.run("validateCitationKey", {project, key: "fresh"})).rejects.toThrow(/inline bibliography/);
    await expect(worker.run("citationImpact", {project, key: "example"})).rejects.toThrow(/inline bibliography/);
    await expect(worker.run("citationRename", {project, from: "example", to: "fresh"})).rejects.toThrow(/inline bibliography/);
  } finally {
    worker.dispose();
  }
});
