import { expect, test } from "vitest";

import { toPublicationDocument } from "../src/project/document";
import { resolveScope } from "../src/project/scope";
import { projectFixture } from "./fixtures";

test("a file override takes priority over the nearest folder", (): void => {
  expect(resolveScope("paper/sub/a.md", { paper: true }, { "paper/sub/a.md": false })).toBe(false);
  expect(resolveScope("paper/sub/a.md", { paper: true, "paper/sub": false }, { "paper/sub/a.md": true })).toBe(true);
});

test("the nearest ancestor wins and unrelated paths default to disabled", (): void => {
  expect(resolveScope("paper/sub/a.md", { paper: true, "paper/sub": false }, {})).toBe(false);
  expect(resolveScope("paper/sub/deep/a.md", { "": false, paper: true }, {})).toBe(true);
  expect(resolveScope("a.md", { "": true }, {})).toBe(true);
  expect(resolveScope("paperless/a.md", { paper: true }, {})).toBe(false);
  expect(resolveScope("outside/a.md", {}, {})).toBe(false);
  expect(resolveScope("paper/../outside/a.md", { paper: true }, {})).toBe(false);
  expect(resolveScope("toString/a.md", {}, {})).toBe(false);
});

test("disabling editing leaves the chapter in the publication", (): void => {
  const project = projectFixture();
  const path = "paper/chapters/z-intro.md";
  expect(resolveScope(path, { paper: true }, { [path]: false })).toBe(false);
  expect(toPublicationDocument(project).chapters.map((chapter: { id: string }): string => chapter.id))
    .toEqual(["intro", "proof"]);
});
test("canonical-equivalent file spellings retain the override", (): void => {
  expect(resolveScope("Café/été.md".normalize("NFD"), {"Café": true}, {"Café/été.md": false})).toBe(false);
  expect(resolveScope("Café/été.md".normalize("NFD"), {}, {"Café/été.md": true})).toBe(true);
});
