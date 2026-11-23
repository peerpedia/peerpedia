import { expect, test } from "vitest";

import { analyzeProject } from "../src/language/analysis";
import { findTarget, referenceAt } from "../src/language/navigation";
import { editFixture, projectFixture } from "./fixtures";

const intro = "chapters/z-intro.md";
const proof = "chapters/a-proof.md";
const bibliography = "references.yaml";

test("locates source keys in separate chapters and shared or inline bibliography", (): void => {
  const chapter = "# 😀 Heading {@sec:here}\r\n\r\n~~~math {@eq:one}\r\nx=1\r\n~~~\r\n\r\n```bibliography\r\ninline:\r\n  title: Sample\r\n```\r\n\r\nSee @thm:main and @example.";
  const shared = "# 😀 comment\r\n'example':\r\n  title: Example\r\n  versions: [{key: example-v2, relation: original}]\r\n";
  const project = editFixture(editFixture(projectFixture(), intro, chapter), bibliography, shared);
  const analysis = analyzeProject(project);
  const tests = [
    ["sec:here", intro, "heading"],
    ["thm:main", proof, "theorem"],
    ["eq:one", intro, "equation"],
    ["inline", intro, "bibliography"],
    ["example", bibliography, "bibliography"],
    ["example-v2", bibliography, "bibliography"],
  ] as const;
  for (const [key, path, kind] of tests) {
    const target = findTarget(key, analysis);
    expect(target).toMatchObject({ path, kind });
    const source = project.files.find((file: { path: string }): boolean => file.path === path)!.text;
    expect(source.slice(target!.from, target!.to)).toBe(key);
  }

  expect(referenceAt(chapter, chapter.lastIndexOf("thm:main") + 2)?.key).toBe("thm:main");
  expect(referenceAt(chapter, chapter.indexOf("sec:here") + 2)).toBeNull();
  expect(referenceAt("Literal `@example` and \\@example", 12)).toBeNull();
  expect(referenceAt("Literal `@example` and \\@example", 28)).toBeNull();
});

test("rejects duplicate normalized labels in one chapter and across files", (): void => {
  const chapter = "# 😀 One {@thm:e\u0301}\n\n::: theorem {@thm:é}\nText.\n:::\n";
  const project = editFixture(editFixture(projectFixture(), intro, chapter), proof, "# Other {@thm:é}\n");
  const analysis = analyzeProject(project);
  expect(findTarget("thm:é", analysis)).toBeNull();
  expect(findTarget("thm:e\u0301", analysis)).toBeNull();
  expect(analysis.diagnostics.filter((item: { message: string }): boolean => item.message.includes("重复标签"))).toEqual([
    expect.objectContaining({ path: intro, from: 11, to: 17 }),
    expect.objectContaining({ path: intro, from: 34, to: 39 }),
    expect.objectContaining({ path: proof }),
  ]);
});

test("invalid definitions receive precise diagnostics and cannot become targets", (): void => {
  const source = "# 😀 One {@bad.}\n\n::: theorem {@bad label}\nText.\n:::\n";
  const project = editFixture(projectFixture(), intro, source);
  const analysis = analyzeProject(project);
  expect(findTarget("bad.", analysis)).toBeNull();
  expect(findTarget("bad label", analysis)).toBeNull();
  const excerpts = analysis.diagnostics
    .filter((item: { path: string; message: string }): boolean => item.path === intro && item.message.includes("无效标签"))
    .map((item: { from: number; to: number }): string => source.slice(item.from, item.to));
  expect(excerpts).toEqual(["bad.", "bad label"]);
});

test("a revised bibliography invalidates the old key and updates the source range", (): void => {
  const before = projectFixture();
  const after = editFixture(before, bibliography, "# 😀 Notes\r\nrenamed:\r\n  title: Example\r\n");
  const previous = analyzeProject(before);
  const current = analyzeProject(after);
  expect(current.revision).not.toBe(previous.revision);
  expect(findTarget("example", previous)).toMatchObject({ from: 0, to: 7 });
  expect(findTarget("example", current)).toBeNull();
  expect(findTarget("renamed", current)).toMatchObject({ path: bibliography, from: 12, to: 19 });
  expect(current.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("example") }));
});

test("recognizes labels alongside normal heading attributes without treating prose as a definition", (): void => {
  const source = "# 😀 Title {@sec:typed .chapter}\n\n## Other {.extra @sec:other}\n\nLook at [a theorem](@thm:main).";
  const analysis = analyzeProject(editFixture(projectFixture(), intro, source));
  for (const key of ["sec:typed", "sec:other"]) {
    const target = findTarget(key, analysis);
    expect(source.slice(target!.from, target!.to)).toBe(key);
  }
  expect(referenceAt(source, source.lastIndexOf("@thm") + 2)?.key).toBe("thm:main");
  expect(referenceAt("[literal @fake](https://example.test)", 12)).toBeNull();
});

test("a bibliography duplicate and a chapter label never resolve to an arbitrary file", (): void => {
  const project = editFixture(projectFixture(), intro, "# 😀 Heading {@example}\n");
  const analysis = analyzeProject(project);
  expect(findTarget("example", analysis)).toBeNull();
  expect(analysis.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: intro, message: expect.stringContaining("重复标签") }),
    expect.objectContaining({ path: bibliography, message: expect.stringContaining("重复标签") }),
    expect.objectContaining({ path: proof, message: expect.stringContaining("有多个定义") }),
  ]));
});

test("only a heading's terminal attribute group declares its label", (): void => {
  const source = [
    "# Heading {.chapter} {@sec:class-first}",
    "",
    "See @sec:class-first.",
    "",
    "## Heading {@sec:class-second} {.chapter}",
    "",
    "See @sec:class-second.",
  ].join("\n");
  const analysis = analyzeProject(editFixture(projectFixture(), intro, source));
  const valid = findTarget("sec:class-first", analysis);
  expect(valid).toMatchObject({ path: intro, kind: "heading" });
  expect(source.slice(valid!.from, valid!.to)).toBe("sec:class-first");
  expect(referenceAt(source, source.indexOf("sec:class-first"))).toBeNull();
  expect(findTarget("sec:class-second", analysis)).toBeNull();
  expect(referenceAt(source, source.indexOf("sec:class-second"))?.key).toBe("sec:class-second");
  expect(analysis.diagnostics.some((issue: { message: string }): boolean => issue.message.includes("class-first"))).toBe(false);
  expect(analysis.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("class-second") }));
});

test("indexes ordered and alphabetic list labels with their own precise ranges", (): void => {
  const source = "# 😀 List\n\n1. {@item:one} A labelled item.\n\n(a) {@item:two} A labelled item.\n\nSee @item:one and @item:two.";
  const analysis = analyzeProject(editFixture(projectFixture(), intro, source));
  for (const key of ["item:one", "item:two"]) {
    const target = findTarget(key, analysis);
    expect(target).toMatchObject({ path: intro, kind: "item" });
    expect(source.slice(target!.from, target!.to)).toBe(key);
    expect(referenceAt(source, source.indexOf(key))).toBeNull();
    expect(referenceAt(source, source.lastIndexOf(key))?.key).toBe(key);
  }
  expect(analysis.diagnostics.filter((issue: { path: string }): boolean => issue.path === intro)).toEqual([]);
});

test.each(["-", "*", "+"])("keeps a braced reference inside a %s bullet from declaring an item", (marker: string): void => {
  const source = `# Bullets\n\n${marker} {@item:bullet} A bullet.\n`;
  const use = "# Other Chapter\n\nSee @item:bullet.";
  const project = editFixture(editFixture(projectFixture(), intro, source), proof, use);
  const analysis = analyzeProject(project);
  expect(findTarget("item:bullet", analysis)).toBeNull();
  expect(referenceAt(source, source.indexOf("item:bullet"))?.key).toBe("item:bullet");
  expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
    path: proof, message: expect.stringContaining("item:bullet"),
  }));
});

test("requires the renderer's label boundary and attributes items after CRLF and emoji", (): void => {
  const source = "# 😀 List\r\n\r\n1. {@item:punctuated}!\r\n2. {@item:real} Text.\r\n";
  const analysis = analyzeProject(editFixture(projectFixture(), intro, source));
  expect(findTarget("item:punctuated", analysis)).toBeNull();
  const real = findTarget("item:real", analysis);
  expect(real).toMatchObject({ path: intro, kind: "item" });
  expect(source.slice(real!.from, real!.to)).toBe("item:real");
});
