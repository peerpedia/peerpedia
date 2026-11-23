import { execFile, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";

import type { RenderRequest, RenderResponse, RenderSuccess } from "../renderer/protocol";
import type { PublicationDocument } from "../src/project/document";
import type { RendererClient } from "../src/preview/renderer-client";

const run = promisify(execFile);
const project = fileURLToPath(new URL("..", import.meta.url));
const fixture = new URL("./fixtures/render-paper.json", import.meta.url);
const temporary: string[] = [];
const clients: RendererClient[] = [];

function expectSuccess(response: RenderResponse): asserts response is RenderSuccess {
  if ("error" in response) throw new Error(JSON.stringify(response.error));
}

async function temporaryDirectory(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "peerpedia-renderer-test-"));
  temporary.push(folder);
  return folder;
}

async function example(): Promise<RenderRequest> {
  const document: PublicationDocument = JSON.parse(await readFile(fixture, "utf8"));
  return { id: "paper", revision: "fixture-r1", document };
}

async function controlledWorker(timeoutMs: number = 1000): Promise<{
  client: RendererClient;
  request: RenderRequest;
  pidFile: string;
}> {
  const { RendererClient: Client } = await import("../src/preview/renderer-client");
  const runtimePath = await temporaryDirectory();
  const pidFile = join(runtimePath, "pids");
  await mkdir(join(runtimePath, "bin"));
  await symlink(process.execPath, join(runtimePath, "bin/node"));
  await writeFile(join(runtimePath, "renderer.mjs"), `
    import { appendFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) {
      const { id, revision } = JSON.parse(line);
      appendFileSync("pids", process.pid + "\\n");
      if (id === "exit") process.exit(9);
      if (id === "hang") await new Promise(/** @returns {void} */ () => {});
      process.stdout.write(JSON.stringify({ id, revision, pages: [] }) + "\\n");
    }
  `);
  const client = new Client({ runtimePath, timeoutMs, cachePath: join(runtimePath, "cache") });
  clients.push(client);
  return { client, request: await example(), pidFile };
}

async function processIds(path: string): Promise<number[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map(Number);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

afterEach(async (): Promise<void> => {
  for (const client of clients.splice(0)) await client.dispose();
  for (const folder of temporary.splice(0)) await rm(folder, { recursive: true, force: true });
});

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "relocates the packaged book renderer and compiles with no PATH, network, or checkout access",
  async (): Promise<void> => {
    const workspace = await temporaryDirectory();
    const original = join(workspace, "package");
    const runtime = join(workspace, "moved renderer");
    await run(process.execPath, [
      join(project, "node_modules/tsx/dist/cli.mjs"), join(project, "scripts/package-renderer.ts"),
      original,
    ]);
    await cp(original, runtime, { recursive: true });
    await rm(original, { recursive: true, force: true });
    const request = await example();
    const invalid: RenderRequest = {
      ...request, id: "invalid", document: { ...request.document, chapters: [], markdown: "Text.\n\n$\\badCommand$" },
    };
    const inline: RenderRequest = {
      ...request, id: "inline", document: {
        ...request.document, chapters: [],
        markdown: ["# Inline sources", "", "[@book]", "", "```bibliography", request.document.bibliography.trimEnd(), "```"].join("\n"),
        bibliography: "",
      },
    };
    const mismatched: RenderRequest = {
      ...request, id: "mismatched", document: { ...request.document, markdown: "Stale combined Markdown." },
    };
    const oversize: RenderRequest = {
      ...request, id: "oversize", document: {
        ...request.document, chapters: [], markdown: "汉".repeat(350_000), bibliography: "",
      },
    };
    const input = [request, invalid, inline, mismatched, oversize]
      .map((value: RenderRequest): string => JSON.stringify(value)).join("\n") + "\n";
    const checkout = JSON.stringify(resolve(project, ".."));
    const policy = `(version 1)(allow default)(deny network*)(deny file-read* (subpath ${checkout}))
      (deny file-write* (subpath ${JSON.stringify(await realpath(runtime))}))`;
    const probe = await run("/usr/bin/sandbox-exec", [
      "-p", policy, join(runtime, "bin/node"), "--input-type=module", "-e", `
        import { readFileSync, writeFileSync } from "node:fs";
        import { createServer } from "node:net";
        try { readFileSync(process.argv[1]); process.exit(5); }
        catch (error) { console.log(error.code); }
        try { writeFileSync(process.argv[2], "blocked"); process.exit(7); }
        catch (error) { console.log(error.code); }
        createServer().on("error", /** @param {Error} error @returns {void} */ (error) =>
          console.log(error.code),
        ).listen(0, "127.0.0.1", /** @returns {void} */ () => process.exit(6));
      `, resolve(project, "../editor/render-document.mjs"), join(runtime, "probe-file"),
    ], { cwd: workspace, env: { PATH: "" }, timeout: 5000 });
    expect(probe.stdout.trim().split("\n")).toEqual(["EPERM", "EPERM", "EPERM"]);
    const { stdout, stderr, status, error } = spawnSync("/usr/bin/sandbox-exec", [
      "-p", policy, join(runtime, "bin/node"), join(runtime, "renderer.mjs"),
    ], { input, encoding: "utf8", cwd: workspace, env: { PATH: "", BANANAMARK_CACHE: join(workspace, "cache") }, timeout: 40_000 });
    if (error) throw error;
    expect(status, stderr).toBe(0);
    expect(stderr).toBe("");
    const [publication, failure, inlineResult, mismatchFailure, oversizeFailure] = stdout.trim().split("\n")
      .map((line: string): RenderResponse => JSON.parse(line));
    expectSuccess(publication);
    expect(publication).toMatchObject({ id: "paper", revision: "fixture-r1" });
    expect(publication.pages.map((page: RenderSuccess["pages"][number]): string => page.id)).toEqual(["intro", "proof"]);
    const [intro, proof] = publication.pages;
    expect(intro.html).toMatch(/Theorem 1\.1/);
    expect(proof.html).toMatch(/Theorem 2\.1/);
    expect(intro.html).toMatch(/\?chapter=proof#thm:second/);
    expect(proof.html).toMatch(/\?chapter=intro#thm:first/);
    expect(proof.html).toMatch(/\?chapter=intro#eq:first/);
    expect(intro.html).toContain("katex");
    expect(intro.html).toContain("\\tag{1.1}");
    expect(proof.html).toContain("\\tag{2.1}");
    expect(proof.html).toContain("Author 2020");
    for (const page of publication.pages) {
      expect(page.html).toContain("<svg");
      expect(page.html).not.toContain("bm-tikz-source");
    }
    expect(proof.html).toContain("tikzjax-msbm10");
    expect(intro.targets).toEqual(expect.arrayContaining([
      { id: "overview", chapterId: "intro", from: 48, to: 59, kind: "heading", source: "chapter" },
      { id: "thm:first", chapterId: "intro", from: 63, to: 87, kind: "theorem", source: "chapter" },
      { id: "eq:first", chapterId: "intro", from: 116, to: 135, kind: "equation", source: "chapter" },
    ]));
    expect(proof.targets).toContainEqual({
      id: "bib-book", chapterId: "proof", from: 0, to: 5, kind: "bibliography", source: "bibliography",
    });
    expect(failure).toMatchObject({ id: "invalid", revision: "fixture-r1", error: { file: "main.md", line: 3 } });
    expect(mismatchFailure).toMatchObject({ id: "mismatched", error: { message: /match the chapter files/ } });
    expect(oversizeFailure).toMatchObject({ id: "oversize", error: { message: /1 MiB/ } });
    expectSuccess(inlineResult);
    expect(inlineResult.pages[0].targets).toContainEqual({
      id: "bib-book", chapterId: "main", from: 43, to: 48, kind: "bibliography", source: "chapter",
    });

    const theme = join(runtime, "theme");
    const css = await readFile(join(theme, "style.css"), "utf8");
    const urls = [...`${intro.html}\n${proof.html}\n${css}`.matchAll(/url\(["']?([^#)"']+)["']?\)/g)];
    expect(urls.length).toBeGreaterThan(10);
    for (const [, url] of urls) {
      expect(url).toMatch(/^\.\/(?:fonts\/katex|tikz)\/[\w.-]+$/);
      await access(join(theme, url), constants.R_OK);
    }
  }, 120_000,
);

test("a worker timeout kills the process and the next render starts a replacement", async (): Promise<void> => {
  const { client, request, pidFile } = await controlledWorker(1000);
  expect(await client.render({ ...request, id: "hang" }, new AbortController().signal))
    .toMatchObject({ id: "hang", revision: request.revision, error: { message: /timed out/i } });
  const [stuck] = await processIds(pidFile);
  expect(await client.render(request, new AbortController().signal)).toEqual({
    id: request.id, revision: request.revision, pages: [],
  });
  const [, replacement] = await processIds(pidFile);
  expect(replacement).not.toBe(stuck);
  expect(processExists(stuck)).toBe(false);
});

test("an unexpected worker exit returns a failure and permits another render", async (): Promise<void> => {
  const { client, request, pidFile } = await controlledWorker();
  expect(await client.render({ ...request, id: "exit" }, new AbortController().signal))
    .toMatchObject({ id: "exit", error: { message: /exit.*9/i } });
  const [exited] = await processIds(pidFile);
  expect(processExists(exited)).toBe(false);
  expectSuccess(await client.render(request, new AbortController().signal));
});

test("abort kills an active worker without interrupting the next queued render", async (): Promise<void> => {
  const { client, request, pidFile } = await controlledWorker(5000);
  const abort = new AbortController();
  const active = client.render({ ...request, id: "hang" }, abort.signal);
  await expect.poll(async (): Promise<number[]> => processIds(pidFile)).toHaveLength(1);
  const [aborted] = await processIds(pidFile);
  const next = client.render(request, new AbortController().signal);
  abort.abort();
  expect(await active).toMatchObject({ id: "hang", error: { message: /cancelled/i } });
  expectSuccess(await next);
  expect(processExists(aborted)).toBe(false);
});

test("dispose reaps the active worker, settles pending work and prevents a restart", async (): Promise<void> => {
  const { client, request, pidFile } = await controlledWorker(5000);
  const active = client.render({ ...request, id: "hang" }, new AbortController().signal);
  await expect.poll(async (): Promise<number[]> => processIds(pidFile)).toHaveLength(1);
  const [pid] = await processIds(pidFile);
  const queued = client.render(request, new AbortController().signal);
  await client.dispose();
  expect(processExists(pid)).toBe(false);
  expect(await active).toMatchObject({ id: "hang", error: { message: /disposed/i } });
  expect(await queued).toMatchObject({ id: request.id, error: { message: /disposed/i } });
  expect(await client.render(request, new AbortController().signal))
    .toMatchObject({ id: request.id, error: { message: /disposed/i } });
  expect(await processIds(pidFile)).toEqual([pid]);
});
