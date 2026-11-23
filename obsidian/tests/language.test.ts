import { expect, test } from "vitest";

import { analyzeProject } from "../src/language/analysis";
import { complete, type Suggestion } from "../src/language/completion";
import { editFixture, projectFixture } from "./fixtures";

const intro = "chapters/z-intro.md";
const proof = "chapters/a-proof.md";

function completions(source: string, explicit: boolean = false, composing: boolean = false): Promise<readonly Suggestion[]> {
  const offset = source.indexOf("▮");
  return complete({ path: intro, source: source.replace("▮", ""), offset, explicit, composing }, analyzeProject(projectFixture()));
}

test("opens a theorem with its closing fence and cursor inside the body", async (): Promise<void> => {
  expect(await completions("😀\n:::th▮")).toContainEqual({
    label: "::: theorem", from: 3, to: 8, insertText: "::: theorem\n\n:::", cursorOffset: 12,
  });
  expect(await completions(":::\t▮", true)).toEqual(expect.arrayContaining([expect.objectContaining({ label: "::: theorem" })]));
});

test("preserves an existing directive name and hands composition back to the host", async (): Promise<void> => {
  expect(await completions(":::th▮eorem")).toEqual([]);
  expect(await completions(":::th▮-other")).toEqual([]);
  expect(await completions(":::th▮", false, true)).toEqual([]);
  expect(await completions(":::th▮ Title")).toContainEqual({
    label: "::: theorem", from: 0, to: 5, insertText: ":::theorem", cursorOffset: 10,
  });
});

test("offers KaTeX commands in BananaMark formulas and closes TeX environments", async (): Promise<void> => {
  expect(await completions("😀 $\\fr▮$")).toContainEqual({
    label: "\\frac", from: 4, to: 7, insertText: "\\frac{}{}", cursorOffset: 6,
  });
  expect(await completions("$$\n\\begin{ali▮}\n$$")).toContainEqual({
    label: "\\begin{aligned}", from: 3, to: 14, insertText: "\\begin{aligned}\n  \n\\end{aligned}", cursorOffset: 18,
  });
  expect(await completions("Plain \\fr▮")).toEqual([]);
  expect(await completions("`$\\fr▮`")).toEqual([]);
  expect(await completions("```text\n$\\fr▮\n```")).toEqual([]);
});

test("suggests supported code blocks without consuming text in an existing block", async (): Promise<void> => {
  expect(await completions("```ti▮")).toContainEqual({
    label: "```tikz", from: 0, to: 5, insertText: "```tikz\n\n```", cursorOffset: 8,
  });
  expect(await completions("`@th▮`")).toEqual([]);
});

test("isolates references across projects and replaces the full current label", async (): Promise<void> => {
  const first = projectFixture();
  const second = editFixture({ ...first, root: "other-paper" }, proof,
    "# Other chapter {@thm:main}\n\n## Private {@thm:private}\n");
  const source = "正文 😀 see {@thm:old}";
  const context = { path: intro, source, offset: source.indexOf("old"), explicit: true, composing: false };
  expect(await complete(context, analyzeProject(first))).toEqual([{
    label: "thm:main", from: 12, to: 19, insertText: "thm:main", cursorOffset: 8,
  }]);
  expect(await complete(context, analyzeProject(second))).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: "thm:private" }),
  ]));
  expect(await completions("A citation @ex▮")).toEqual([expect.objectContaining({ label: "example" })]);
});

test("finds unknown references even after a recoverable editing error", (): void => {
  const source = "😀 see @unknown.\n\n::: theorem {@thm:draft}\nSome text.";
  const analysis = analyzeProject(editFixture(projectFixture(), intro, source));
  expect(analysis.labels).toEqual(expect.arrayContaining([expect.objectContaining({ key: "thm:draft" })]));
  expect(analysis.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: intro, from: 7, to: 15, message: expect.stringContaining("unknown") }),
  ]));
  const valid = editFixture(projectFixture(), "references.yaml", "example:\n  type: book\n  title: Example\n");
  expect(analyzeProject(valid).diagnostics).toEqual([]);
  expect(analyzeProject(projectFixture()).diagnostics).toContainEqual(expect.objectContaining({
    path: "references.yaml", message: expect.stringContaining("type"),
  }));
});

test("completes cross-chapter references in environment titles and skips escapes", async (): Promise<void> => {
  expect(await completions("::: theorem [Using @th▮]")).toEqual([
    expect.objectContaining({ label: "thm:main" }),
  ]);
  expect(await completions("\\{@th▮}")).toEqual([]);
});

test("closes a nested directive using its actual fence length", async (): Promise<void> => {
  expect(await completions("::::the▮\n\n::: lemma\nText.\n:::")).toContainEqual({
    label: "::: theorem", from: 0, to: 7, insertText: ":::: theorem\n\n::::", cursorOffset: 13,
  });
});
