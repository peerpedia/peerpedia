import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { renderDocument } from "../../packages/peerpedia-renderer/node.mjs";
import { renderRequest } from "../renderer/render-request";
import type {
  RenderRequest,
  RenderResponse,
  RenderSuccess,
} from "../renderer/protocol";
import type { PublicationDocument } from "../src/project/document";

function expectSuccess(
  response: RenderResponse,
): asserts response is RenderSuccess {
  if ("error" in response) throw new Error(JSON.stringify(response.error));
}

test("the production request handler preserves book rendering, source ranges and diagnostics", async (): Promise<void> => {
  const document: PublicationDocument = JSON.parse(
    await readFile(
      new URL("./fixtures/render-paper.json", import.meta.url),
      "utf8",
    ),
  );
  const request: RenderRequest = {
    id: "paper",
    revision: "fixture-r1",
    document,
  };
  const invalid: RenderRequest = {
    ...request,
    id: "invalid",
    document: {
      ...request.document,
      chapters: [],
      markdown: "Text.\n\n$\\badCommand$",
    },
  };
  const invalidTikz: RenderRequest = {
    ...request,
    id: "invalid-tikz",
    document: {
      ...request.document,
      chapters: [],
      markdown: [
        "```tikz",
        "\\begin{tikzpicture}",
        "\\badCommand",
        "\\end{tikzpicture}",
        "```",
      ].join("\n"),
    },
  };
  const inline: RenderRequest = {
    ...request,
    id: "inline",
    document: {
      ...request.document,
      chapters: [],
      markdown: [
        "# Inline sources",
        "",
        "[@book]",
        "",
        "```bibliography",
        request.document.bibliography.trimEnd(),
        "```",
      ].join("\n"),
      bibliography: "",
    },
  };
  const mismatched: RenderRequest = {
    ...request,
    id: "mismatched",
    document: { ...request.document, markdown: "Stale combined Markdown." },
  };
  const oversize: RenderRequest = {
    ...request,
    id: "oversize",
    document: {
      ...request.document,
      chapters: [],
      markdown: "汉".repeat(350_000),
      bibliography: "",
    },
  };
  const responses: RenderResponse[] = [];
  for (const input of [
    request,
    invalid,
    invalidTikz,
    invalidTikz,
    inline,
    mismatched,
    oversize,
  ]) {
    responses.push(await renderRequest(input, renderDocument));
  }
  const [
    publication,
    failure,
    tikzFailure,
    repeatedTikzFailure,
    inlineResult,
    mismatchFailure,
    oversizeFailure,
  ] = responses;
  expectSuccess(publication);
  expect(publication).toMatchObject({ id: "paper", revision: "fixture-r1" });
  expect(
    publication.pages.map(
      (page: RenderSuccess["pages"][number]): string => page.id,
    ),
  ).toEqual(["intro", "proof"]);
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
  expect(intro.targets).toEqual(
    expect.arrayContaining([
      {
        id: "overview",
        chapterId: "intro",
        from: 48,
        to: 59,
        kind: "heading",
        source: "chapter",
      },
      {
        id: "thm:first",
        chapterId: "intro",
        from: 63,
        to: 87,
        kind: "theorem",
        source: "chapter",
      },
      {
        id: "eq:first",
        chapterId: "intro",
        from: 116,
        to: 135,
        kind: "equation",
        source: "chapter",
      },
    ]),
  );
  expect(proof.targets).toContainEqual({
    id: "bib-book",
    chapterId: "proof",
    from: 0,
    to: 5,
    kind: "bibliography",
    source: "bibliography",
  });
  expect(failure).toMatchObject({
    id: "invalid",
    revision: "fixture-r1",
    error: {
      file: "main.md",
      line: 3,
      message: /undefined control sequence.*badCommand/i,
    },
  });
  expect(tikzFailure).toMatchObject({
    id: "invalid-tikz",
    revision: "fixture-r1",
    error: {
      file: "main.md",
      message: /TikZ compilation failed: ! Undefined control sequence/,
    },
  });
  expect(repeatedTikzFailure).toEqual(tikzFailure);
  expect(mismatchFailure).toMatchObject({
    id: "mismatched",
    error: { message: /match the chapter files/ },
  });
  expect(oversizeFailure).toMatchObject({
    id: "oversize",
    error: { message: /1 MiB/ },
  });
  expectSuccess(inlineResult);
  expect(inlineResult.pages[0].targets).toContainEqual({
    id: "bib-book",
    chapterId: "main",
    from: 43,
    to: 48,
    kind: "bibliography",
    source: "chapter",
  });

  const hiddenFailure = await renderRequest(
    request,
    async (): Promise<never> => {
      throw new Error("sensitive engine path and token");
    },
  );
  expect(hiddenFailure).toHaveProperty("error");
  expect(JSON.stringify(hiddenFailure)).not.toContain("sensitive engine path");
}, 40_000);
