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

test.each(["[[My note]]", "![image](figure.png)"])("citation rename preserves %s and its publication diagnostic", async (markup: string): Promise<void> => {
  const path = "chapters/z-intro.md";
  const source = "See @example and " + markup + ".\n";
  const project = editFixture(projectFixture(), path, source);
  const worker = new LanguageWorker(bundled, nodeThread);
  try {
    expect((await worker.run("analyze", project)).analysis.diagnostics).toContainEqual(
      expect.objectContaining({path, from: source.indexOf(markup), message: expect.stringMatching(/Image embeds|Obsidian/) }));
    expect((await worker.run("citationRename", {project, from: "example", to: "fresh"})).changes).toContainEqual(
      expect.objectContaining({path, afterText: source.replace("@example", "@fresh")}));
  } finally {
    worker.dispose();
  }
});

test.each(["entry: [broken", "*missing", "entry: *missing", "entry: {versions: *missing}"])(
  "unreadable inline YAML blocks citation rename: %s", async (yaml: string): Promise<void> => {
  const path = "chapters/z-intro.md";
  const source = "~~~bibliography\n" + yaml + "\n~~~\n";
  const project = editFixture(projectFixture(), path, source);
  const worker = new LanguageWorker(bundled, nodeThread);
  try {
    if (yaml.includes("*missing")) {
      expect((await worker.run("analyze", project)).analysis.diagnostics).toContainEqual(
        expect.objectContaining({path, from:source.indexOf(yaml), to:source.indexOf("\n~~~") + 1, code:"bibliography-yaml"}));
    }
    await expect(worker.run("citationRename", {project, from: "example", to: "fresh"})).rejects.toThrow(/inline bibliography/);
  } finally {
    worker.dispose();
  }
});

test("cancelling one shared-language request preserves other consumers and ignores its late reply", async (): Promise<void> => {
  let respond: (response: LanguageResponse) => void = (): void => {};
  const sent: LanguageRequest[] = [];
  let closes = 0;
  const thread: LanguageThread = {
    onResponse(listener: (response: LanguageResponse) => void): void { respond = listener; },
    onFailure(_listener: (error: Error) => void): void {},
    request(message: LanguageRequest): void { sent.push(message); },
    close(): void { closes++; },
  };
  const worker = new LanguageWorker("", (): LanguageThread => thread);
  const abort = new AbortController();
  let outcome = "pending";
  const cancelled = worker.run("title", "# Cancelled", abort.signal).then(
    (): void => { outcome = "completed"; },
    (): void => { outcome = "cancelled"; },
  );
  const other = worker.run("title", "# Other");
  try {
    abort.abort();
    await expect.poll((): string => outcome, {timeout:200}).toBe("cancelled");
    expect(closes).toBe(0);
    respond({id:sent[0].id,kind:"title",value:"Cancelled"});
    respond({id:sent[1].id,kind:"title",value:"Other"});
    expect(await other).toBe("Other");
    await cancelled;
  } finally { worker.dispose(); await other.catch((): void => {}); }
  expect(closes).toBe(1);
});

test("shared analysis and completion follow the latest draft across papers with identical member paths", async (): Promise<void> => {
  const worker = new LanguageWorker(bundled, nodeThread);
  const path = "chapters/z-intro.md";
  const first = editFixture(projectFixture(), path, "# First {@first}\n\n@");
  const second = {...editFixture(projectFixture(), path, "# Second {@second}\n\n@"), root:"other-paper"};
  try {
    for (const project of [first, second, first]) {
      await worker.run("analyze", project);
      const source = project.files.find((file: {path:string}): boolean => file.path === path)!.text;
      const items = await worker.run("complete", {project,context:{path,source,offset:source.length,explicit:true,composing:false}});
      const wanted = project === first ? "first" : "second";
      expect(items.some((item: {label:string}): boolean => item.label === wanted)).toBe(true);
      expect(items.some((item: {label:string}): boolean => item.label === (wanted === "first" ? "second" : "first"))).toBe(false);
    }
  } finally { worker.dispose(); }
});
