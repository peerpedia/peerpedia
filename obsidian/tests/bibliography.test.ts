import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Vault } from "obsidian";
import { expect, test } from "vitest";

import { readEntries, restoreSourceLineEndings } from "../src/bibliography/document";
import { planCitationRename, previewCitationRename } from "../src/bibliography/rename";
import { VaultProjectStore } from "../src/host/vault-store";
import type { SourceFile } from "../src/project/types";
import type { FileChange } from "../src/project/store";
import { editFixture, projectFixture } from "./fixtures";

const aliasedVersion = "example:\n  type: book\n  title: &shared other\n  shorttitle: *shared\n"
  + "  versions: [{relation: edition, key: *shared}]\n";

const anchoredRecord = "example: &record\n  type: book\n  title: Original\n  note: 'See @example.'\n"
  + "other:\n  type: book\n  title: Other\n  local-record: *record\n";

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

test("source validation rejects malformed YAML and invalid root or entry structures", (): void => {
  for (const source of ["example: [oops\n", "- title: Nope\n", "example: 42\n", "example: {title: A, title: B}\n", "example: {title: A}\n---\nexample: {title: B}\n", "example: {title: !!unknown A}\n"]) {
    expect((): ReturnType<typeof readEntries> => readEntries(source)).toThrow();
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
  const impact = previewCitationRename(project, "example", "updated").references;
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
  expect(previewCitationRename(project, "example", "updated").references).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "references.yaml", entry: "other", field: "note" }),
    expect.objectContaining({ path: "references.yaml", entry: "other", field: "howpublished" }),
    expect.objectContaining({ path: "references.yaml", entry: "other", field: "note", version: 1 }),
    expect.objectContaining({ path: "chapters/z-intro.md", entry: "inline", field: "note" }),
  ]));
});

test("renaming a citation in YAML prose stops if the enclosing entry is aliased", (): void => {
  const project = editFixture(projectFixture(), "references.yaml", anchoredRecord);
  expect((): readonly FileChange[] => planCitationRename(project, "example", "updated")).toThrow(/note.*YAML source file/);
});

test.each([
  ["version mapping", "  versions:\n    - &shared\n      relation: edition\n      note: 'See @example.'\n"],
  ["version sequence", "  versions: &shared\n    - relation: edition\n      note: 'See @example.'\n"],
])("renaming a citation stops if its enclosing %s is aliased", (_kind: string, versions: string): void => {
  const source = "example:\n  type: book\n  title: Original\n" + versions
    + "other:\n  type: book\n  title: Other\n  local-version: *shared\n";
  const project = editFixture(projectFixture(), "references.yaml", source);
  expect((): readonly FileChange[] => planCitationRename(project, "example", "updated")).toThrow(/note.*YAML source file/);
});

test("renaming an anchored citation key does not change an aliased title field", (): void => {
  const source = "? &shared example\n: {type: book, title: A}\nother: {type: book, title: B, shorttitle: *shared}\n";
  const project = editFixture(projectFixture(), "references.yaml", source);
  expect((): readonly FileChange[] => planCitationRename(project, "example", "updated")).toThrow(/Citation key.*example.*YAML source file/);
});

test("renaming an entry keeps its alternate version key and citations intact", (): void => {
  const source = "example:\n  type: book\n  title: A\n  versions: [{relation: edition, key: second}]\n";
  const project = editFixture(editFixture(projectFixture(), "references.yaml", source), "chapters/z-intro.md", "See @second.");
  const renamed = previewCitationRename(project, "example", "updated");
  expect(renamed.references.map((entry: {key: string}): string => entry.key)).toEqual(["example"]);
  expect(renamed.changes.some((change: FileChange): boolean => change.path === "chapters/z-intro.md")).toBe(false);
  expect(renamed.changes[0].afterText).toContain("key: second");
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

test("rename rejects a key defined by an alias in a shared bibliography version", (): void => {
  const project = editFixture(projectFixture(), "references.yaml", aliasedVersion);
  expect((): readonly FileChange[] => planCitationRename(project, "example", "other")).toThrow(/Citation key "other" already exists/);
});

test("rename rejects a key defined by an aliased inline bibliography version", (): void => {
  const inline = "~~~bibliography\n" + aliasedVersion.replace("example:", "inline-entry:") + "~~~\n";
  const project = editFixture(projectFixture(), "chapters/z-intro.md", inline);
  expect((): readonly FileChange[] => planCitationRename(project, "example", "other")).toThrow(/Citation key "other" already exists/);
});

test("renaming a citation key checks validity and shared definitions before saving", (): void => {
  const project = projectFixture();
  for (const key of ["example", "sec:intro", "thm:main", "bad key", "-reserved"]) {
    expect((): readonly FileChange[] => planCitationRename(project, "example", key)).toThrow();
  }
  expect((): readonly FileChange[] => planCitationRename(project, "example", "new-citation")).not.toThrow();
});

test("a stale bibliography source draft cannot overwrite externally changed YAML", async (): Promise<void> => {
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
    const draft = "# Source draft\n" + file.text;
    const disk = join(root, file.path);
    const external = "# 外部修改\r\n" + file.text;
    await writeFile(disk, external);
    await expect(store.apply(opened.root, opened.revision, [
      {path: file.path, beforeDigest: file.digest, afterText: draft},
    ])).rejects.toThrow("The paper changed elsewhere");
    expect(await readFile(disk, "utf8")).toBe(external);
    expect(readEntries(draft)).toEqual(readEntries(file.text));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
