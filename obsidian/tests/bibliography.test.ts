import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Vault } from "obsidian";
import { expect, test } from "vitest";

import { addEntry, patchEntry, readEntries, removeEntry, restoreSourceLineEndings } from "../src/bibliography/document";
import { citationImpact, planCitationRename, validateNewCitationKey } from "../src/bibliography/rename";
import { VaultProjectStore } from "../src/host/vault-store";
import type { SourceFile } from "../src/project/types";
import type { FileChange } from "../src/project/store";
import { editFixture, projectFixture } from "./fixtures";

test("editing a scalar keeps comments, unknown fields, formatting, BOM, and CRLF", (): void => {
  const source = "\uFEFF# 书目\r\n---\r\n\"example\" : # 条目\r\n"
    + "   title : '原题'   # 译名待定\r\n   local-data: { enabled: true,   list: [a,b] }\r\n\r\n"
    + "other: {title: untouched, type: book} # 另一条\r\n...";
  const updated = patchEntry(source, "example", { title: "新题" });
  expect(updated).toBe(source.replace("'原题'", "'新题'"));
  expect(readEntries(updated)).toEqual([
    { key: "example", fields: { title: "新题", "local-data": { enabled: true, list: ["a", "b"] } } },
    { key: "other", fields: { title: "untouched", type: "book" } },
  ]);
});

test("editing a block scalar preserves its header comment and neighboring bytes", (): void => {
  const updated = patchEntry("work:\r\n  title: |- # 标题\r\n    old\r\n  year: 2026\r\n", "work", {title: "更新\n标题"});
  expect(updated).toBe("work:\r\n  title: |- # 标题\r\n    更新\r\n    标题\r\n  year: 2026\r\n");
});

test("adding a field preserves unrelated flow and block formatting", (): void => {
  const flow = "work: {title : old, local: [a, b],  } # comment\n";
  const block = "work:\n   title :  old  # comment\nnext: { title: next }\n";
  expect(patchEntry(flow, "work", { year: 2026 })).toBe("work: {title : old, local: [a, b],  year: 2026} # comment\n");
  expect(patchEntry(block, "work", { year: 2026 })).toBe("work:\n   title :  old  # comment\n   year: 2026\nnext: { title: next }\n");
});

test("flow punctuation in a patched value stays inside that field", (): void => {
  const source = "work: { title: old, type: book } # preserve\n";
  const updated = patchEntry(source, "work", { title: "New, expanded title" });
  expect(readEntries(updated)).toEqual([{key: "work", fields: {title: "New, expanded title", type: "book"}}]);
  expect(updated).toMatch(/^work: \{ title: .+, type: book \} # preserve\n$/);
});

test("the edit form can fill an empty YAML field without moving its comment", (): void => {
  const source = "work:\n  title:\n  author:  # add author\n  type: book\n";
  expect(patchEntry(source, "work", {title: "New title", author: "New Author"})).toBe(
    "work:\n  title: New title\n  author:  New Author # add author\n  type: book\n");
});

test("source editing keeps mixed line endings on untouched lines", (): void => {
  const original = "\uFEFF# first\r\nwork:\n  title: old\r\n# footer\n";
  const draft = "\uFEFF# first\nwork:\n  title: new\n  type: book\n# footer\n";
  expect(restoreSourceLineEndings(original, draft)).toBe("\uFEFF# first\r\nwork:\n  title: new\r\n  type: book\r\n# footer\n");
});

test("escaped braced references stay literal during rename", (): void => {
  const chapter = "See \\{@example}, \\@example, and {@example}; then \\{@literal @example}.\n";
  const project = editFixture(projectFixture(), "chapters/z-intro.md", chapter);
  expect(planCitationRename(project, "example", "updated")
    .find((change: FileChange): boolean => change.path === "chapters/z-intro.md")?.afterText)
    .toBe("See \\{@example}, \\@example, and {@updated}; then \\{@literal @example}.\n");
});

test("adding and deleting entries retains adjacent YAML and its comments", (): void => {
  const keep = "# 书目说明\r\na: {type: book, title: A}   # 保留\r\n";
  const source = keep + "b:\r\n  title: B\r\n  type: book\r\n";
  expect(removeEntry(source, "b")).toBe(keep);
  expect(addEntry(keep, "b", { title: "B", type: "book" })).toBe(source);
  expect(readEntries(removeEntry(keep, "a"))).toEqual([]);
  expect(removeEntry(keep, "a")).toContain("# 书目说明");
  expect((): string => addEntry(source, "a", {title: "覆盖"})).toThrow();
});

test("malformed YAML and invalid root or entry structures cannot be patched", (): void => {
  for (const source of ["example: [oops\n", "- title: Nope\n", "example: 42\n", "example: {title: A, title: B}\n", "example: {title: A}\n---\nexample: {title: B}\n", "example: {title: !!unknown A}\n"]) {
    expect((): ReturnType<typeof readEntries> => readEntries(source)).toThrow();
    expect((): string => patchEntry(source, "example", {title: "lost"})).toThrow();
    expect((): string => addEntry(source, "new", {title: "new"})).toThrow();
  }
});

test("rename changes the key and parsed references in every chapter, preserving literals and line endings", (): void => {
  const first = "正文 😀 @example, {@example}， [另见](@example) and [@example-suffix].\r\n\r\n"
    + "`@example` \\@example test@example.org $@example$\r\n\r\n```md\r\n@example\r\n```\r\n"
    + "\r\n    @example\r\n\r\n<!-- @example -->\r\n";
  const base = editFixture(projectFixture(), "chapters/z-intro.md", first);
  const bibliography = "# references\r\n'example': {title: '@example', type: book}  # @example\r\n";
  const project = editFixture(base, "references.yaml", bibliography);
  const changes = planCitationRename(project, "example", "新参考");
  expect(changes).toHaveLength(3);
  expect(changes).toContainEqual({
    path: "references.yaml",
    beforeDigest: project.files.find((file: SourceFile): boolean => file.path === "references.yaml")!.digest,
    afterText: "# references\r\n'新参考': {title: '@example', type: book}  # @example\r\n",
  });
  expect(changes.find((item: FileChange): boolean => item.path === "chapters/z-intro.md")?.afterText)
    .toBe(first.replace("@example, {@example}， [另见](@example)", "@新参考, {@新参考}， [另见](@新参考)"));
  expect(changes.find((item: FileChange): boolean => item.path === "chapters/a-proof.md")?.afterText)
    .toBe("Proof\n=====\n\n::: theorem {@thm:main}\nA statement [@新参考].\n:::\n");
  const impact = citationImpact(project, "example");
  expect(impact.map(({path, line}: {path: string; line: number}): [string, number] => [path, line])).toEqual([
    ["chapters/z-intro.md", 1], ["chapters/z-intro.md", 1], ["chapters/z-intro.md", 1], ["chapters/a-proof.md", 5],
  ]);
});

test("rename follows rendered TikZ and custom citation captions while leaving literal captions alone", (): void => {
  const chapter = "::: theorem [See @example] {@thm:caption}\r\nProof.\r\n:::\r\n\r\n"
    + "[See @example and `@example`](@example) [plain @example](https://example.org)\r\n\r\n"
    + "~~~tikz {caption=\"See @example, {@example}, \\@example, and `@example`\"}\r\n@example\r\n~~~\r\n";
  const project = editFixture(projectFixture(), "chapters/z-intro.md", chapter);
  const changes = planCitationRename(project, "example", "updated");
  expect(changes.find((item: FileChange): boolean => item.path === "chapters/z-intro.md")?.afterText)
    .toBe("::: theorem [See @updated] {@thm:caption}\r\nProof.\r\n:::\r\n\r\n"
      + "[See @updated and `@example`](@updated) [plain @example](https://example.org)\r\n\r\n"
      + "~~~tikz {caption=\"See @updated, {@updated}, \\@example, and `@example`\"}\r\n@example\r\n~~~\r\n");
});

test("rename updates rendered YAML prose in shared, inline, and version fields", (): void => {
  const shared = "example: {type: book, title: '@example'} # known key\r\n"
    + "other:\r\n  type: book\r\n  title: Other\r\n"
    + "  note: >- # folded note\r\n    See @example.\r\n    Keep `@example` literal.\r\n"
    + "  howpublished: 'See [this](@example).'\r\n"
    + "  custom: {literal: '@example',   unknown: [1,2]}\r\n"
    + "  versions:\r\n    - relation: edition\r\n      note: 'The first is {@example}.' # version note\r\n";
  const inline = "A body @example.\n\n~~~bibliography\n"
    + "inline: {type: book, title: '@example', note: '@example and `@example`.'} # intact\n~~~\n"
    + "\n~~~yaml\ninline: {note: '@example'}\n~~~\n";
  const project = editFixture(editFixture(projectFixture(), "references.yaml", shared), "chapters/z-intro.md", inline);
  const edits = planCitationRename(project, "example", "new-key");
  const changedShared = edits.find((change: FileChange): boolean => change.path === "references.yaml")!.afterText!;
  expect(changedShared).toContain("new-key: {type: book, title: '@example'} # known key\r\n");
  expect(changedShared).toContain("note: >- # folded note\r\n");
  expect(changedShared).toContain("  custom: {literal: '@example',   unknown: [1,2]}\r\n");
  expect(changedShared).toContain("note: 'The first is {@new-key}.' # version note\r\n");
  expect(readEntries(changedShared)[1].fields).toMatchObject({
    note: "See @new-key. Keep `@example` literal.",
    howpublished: "See [this](@new-key).",
  });
  const changedInline = edits.find((change: FileChange): boolean => change.path === "chapters/z-intro.md")!.afterText!;
  expect(changedInline).toBe(inline.replace("body @example", "body @new-key").replace("note: '@example and", "note: '@new-key and"));
  expect(citationImpact(project, "example")).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "references.yaml", entry: "other", field: "note" }),
    expect.objectContaining({ path: "references.yaml", entry: "other", field: "howpublished" }),
    expect.objectContaining({ path: "references.yaml", entry: "other", field: "note", version: 1 }),
    expect.objectContaining({ path: "chapters/z-intro.md", entry: "inline", field: "note" }),
  ]));
});

test("deleting an entry reports references to its alternate versions", (): void => {
  const source = "example:\n  type: book\n  title: A\n  versions: [{relation: edition, key: second}]\n";
  const project = editFixture(editFixture(projectFixture(), "references.yaml", source), "chapters/z-intro.md", "See @second.");
  expect(citationImpact(project, "example").map((entry: {key: string}): string => entry.key)).toEqual(["second", "example"]);
});

test("rename rejects collisions with shared entries, version keys, and chapter definitions", (): void => {
  const withDuplicate = editFixture(projectFixture(), "references.yaml",
    "example: {title: A, versions: [{relation: edition, key: v2}]}\nother: {title: B}\ncafé: {title: C}\n");
  for (const taken of ["other", "v2", "cafe\u0301", "sec:intro", "thm:main"]) {
    expect((): readonly FileChange[] => planCitationRename(withDuplicate, "example", taken)).toThrow();
  }
  const withInline = editFixture(withDuplicate, "chapters/z-intro.md", "```bibliography\ninline: {type: book, title: A}\n```\n");
  expect((): readonly FileChange[] => planCitationRename(withInline, "example", "inline")).toThrow();
  const ambiguous = editFixture(withInline, "chapters/z-intro.md", "# Duplicate {@example}\n");
  expect((): readonly FileChange[] => planCitationRename(ambiguous, "example", "free")).toThrow();
});

test("adding a citation key checks inline and shared definitions before saving", (): void => {
  const project = projectFixture();
  for (const key of ["example", "sec:intro", "thm:main", "bad key", "-reserved"]) {
    expect((): void => validateNewCitationKey(project, key)).toThrow();
  }
  expect((): void => validateNewCitationKey(project, "new-citation")).not.toThrow();
});

test("a stale bibliography form cannot overwrite externally changed YAML", async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "peerpedia-bibliography-"));
  const fixture = projectFixture();
  const root = join(directory, fixture.root);
  try {
    for (const file of fixture.files) {
      const destination = join(root, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.text);
    }
    const host = {} as Pick<Vault, "on" | "offref">;
    const store = new VaultProjectStore(await realpath(directory), host);
    const opened = await store.read(fixture.root);
    const file = opened.files.find((item: SourceFile): boolean => item.path === "references.yaml")!;
    const draft = patchEntry(file.text, "example", {title: "表单草稿"});
    const disk = join(root, file.path);
    const external = "# 外部修改\r\n" + file.text;
    await writeFile(disk, external);
    await expect(store.apply(opened.root, opened.revision, [
      {path: file.path, beforeDigest: file.digest, afterText: draft},
    ])).rejects.toThrow("论文已在其他地方更改");
    expect(await readFile(disk, "utf8")).toBe(external);
    expect(readEntries(draft)[0].fields.title).toBe("表单草稿");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
