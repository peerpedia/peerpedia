import type { SyntaxMark } from "../src/language/index";
import { expect, test, vi } from "vitest";
import * as diagnostics from "../src/language/diagnostics";

import { analyzeProject, analyzeWriting } from "../src/language/analysis";
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
  expect(analyzeProject(projectFixture()).diagnostics).toEqual([]);
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

test("manual completion opens a bare fence and reuses a closer belonging to that fence", async (): Promise<void> => {
  const noClose = await completions(":::▮", true);
  expect(noClose).toContainEqual({
    label: "::: theorem", from: 0, to: 3, insertText: "::: theorem\n\n:::", cursorOffset: 12,
  });
  const closed = await completions(":::▮\nBody text.\n:::\n\n:::: lemma\nUnclosed.", true);
  expect(closed).toContainEqual({
    label: "::: theorem", from: 0, to: 3, insertText: "::: theorem", cursorOffset: 11,
  });
  const otherWidth = await completions("::::▮\nBody text.\n:::", true);
  expect(otherWidth).toContainEqual({
    label: "::: theorem", from: 0, to: 4, insertText: ":::: theorem\n\n::::", cursorOffset: 13,
  });
});

test("an independently malformed bibliography retains a strict syntax diagnostic", (): void => {
  const malformed = editFixture(projectFixture(), "references.yaml", "example:\n  title: An example\n");
  expect(analyzeProject(malformed).diagnostics).toContainEqual(expect.objectContaining({
    path: "references.yaml", message: expect.stringContaining("type"),
  }));
});

test("completes a reference to a list item defined in another chapter", async (): Promise<void> => {
  const source = "See @item:";
  const project = editFixture(projectFixture(), proof, "# List Items\n\n1. {@item:one} First\n");
  expect(await complete({
    path: intro, source, offset: source.length, explicit: false, composing: false,
  }, analyzeProject(project))).toEqual([
    expect.objectContaining({ label: "item:one", insertText: "item:one" }),
  ]);
});

test("finds the cited version definition at the alias occurrence, not at its title anchor", (): void => {
  const yaml = "example:\n  type: book\n  title: &shared other\n  versions: [{relation: edition, key: *shared}]\n";
  const file = "references.yaml";
  const project = editFixture(editFixture(projectFixture(), file, yaml), intro, "See @other.\n");
  const analysis = analyzeProject(project);
  const start = yaml.indexOf("*shared");
  expect(analysis.labels).toContainEqual({
    path: file, key: "other", label: "other", kind: "bibliography", from: start, to: start + "*shared".length,
  });
  expect(analysis.diagnostics).toEqual([]);
});
test("reports image and literal wiki syntax at the actual chapter offsets", (): void => {
  const tokens = ["![图](figure.png)", "![[figure.png]]", "[[普通笔记|别名]]"];
  const source = "😀\r\n" + tokens.join(" ") + "\r\n\r\n`[[code]]`\n\n~~~md\n![[example]]\n~~~\n";
  const issues = analyzeProject(editFixture(projectFixture(), intro, source)).diagnostics
    .filter((issue: {path: string}): boolean => issue.path === intro);
  expect(issues.map((issue: {from: number; to: number}): string => source.slice(issue.from, issue.to))).toEqual(tokens);
});

test("a lone CR cannot introduce an ordered-list label", (): void => {
  const result = analyzeProject(editFixture(projectFixture(), intro, "Prose\r1. {@item:false} First"));
  expect(result.labels.some((label: {key: string}): boolean => label.key === "item:false")).toBe(false);
});
test("the publication image rule also inspects nested link contents", (): void => {
  const source = "[![caption](figure.png)](article)";
  const issues = analyzeProject(editFixture(projectFixture(), intro, source)).diagnostics;
  expect(issues).toContainEqual({code:"publication-compatibility", path:intro, from:1, to:23, message:"Use TikZ figures for publication. Image embeds are unsupported."});
});

test("preserves upstream syntax classes for TeX commands, delimiters, environments and references", (): void => {
  const source = "😀\r\n::: theorem [Test] {@thm:test}\r\n$\\frac{a}{b}$ and @thm:test\r\n:::\r\n";
  const chapter = analyzeWriting(editFixture(projectFixture(), intro, source), new Map()).chapters.get(intro)!;
  const normalized = source.replace(/\r\n/g, "\n");
  const tokens = chapter.marks.filter((mark: SyntaxMark): boolean => Boolean(mark.classes));
  expect(tokens).toEqual(expect.arrayContaining([
    expect.objectContaining({from:normalized.indexOf("\\frac"), to:normalized.indexOf("\\frac") + 5, classes:expect.stringContaining("bm-hl-command")}),
    expect.objectContaining({classes:expect.stringContaining("bm-hl-environment-name")}),
    expect.objectContaining({classes:expect.stringContaining("bm-hl-reference")}),
  ]));
  expect(tokens.some((mark: SyntaxMark): boolean => normalized.slice(mark.from, mark.to) === "$" && mark.classes!.includes("bm-hl"))).toBe(true);
});

test("reuses complete validation for unchanged chapters while checking edited text", (): void => {
  const cache = new Map();
  const project = projectFixture();
  const check = vi.spyOn(diagnostics, "checkChapter");
  try {
    analyzeWriting(project, cache);
    check.mockClear();
    const cached = analyzeWriting(project, cache);
    expect(check).not.toHaveBeenCalled();
    expect(cached).toEqual(analyzeWriting(project, new Map()));
    check.mockClear();
    const changed = editFixture(project, intro, "# **Introduction** {@sec:intro}\r\n\r\nChanged text $\\badcommand$. See @thm:main.\r\n");
    const result = analyzeWriting(changed, cache);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0][0]).toBe(intro);
    expect(result).toEqual(analyzeWriting(changed, new Map()));
    expect(result.analysis.diagnostics.some((issue: {path: string}): boolean => issue.path === intro)).toBe(true);
  } finally { check.mockRestore(); }
});

test("cached diagnostics follow changed definitions, bibliography, errors and CRLF positions", (): void => {
  const cache = new Map();
  let project = editFixture(projectFixture(), intro, "# Introduction\r\n\r\n😀 See @thm:main and [@example].\r\n");
  analyzeWriting(project, cache);
  const edits: [string, string][] = [
    [proof, "# Proof\n\n::: theorem {@thm:renamed}\nCorrect.\n:::\n"],
    ["references.yaml", "other: {type: book, title: Other}\n"],
    [proof, "# Proof\n\n::: theorem {@thm:main}\nCorrect.\n:::\n"],
    [intro, "# Introduction\r\n\r\n::: theorem {@thm:main}\r\nDuplicate\r\n:::\r\nSee @thm:main.\r\n"],
    [proof, "# Proof\n\nNo definition.\n"],
    ["references.yaml", "example: [broken"],
    ["references.yaml", "example: {type: book, title: Restored}\n"],
    [intro, "# Introduction\r\n\r\n::: theorem {@thm:main}\r\nFixed.\r\n:::\r\nSee @thm:main and [@example].\r\n"],
  ];
  for (const [path, text] of edits) {
    project = editFixture(project, path, text);
    expect(analyzeWriting(project, cache), path).toEqual(analyzeWriting(project, new Map()));
  }
  expect(analyzeWriting(project, cache).analysis.diagnostics).toEqual([]);
});
