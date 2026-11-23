import { expect, test, vi } from "vitest";
import type { RenderSuccess, SourceTarget } from "../renderer/protocol";
import { bindSourceButton, locatePreview, rawCoordinates, targetPath } from "../src/preview/source-map";
import { projectFixture } from "./fixtures";

test("the source button responds only to an explicit click, including while the preview scrolls", (): void => {
  const button = new EventTarget();
  const open = vi.fn((): void => {});
  bindSourceButton(button, open);
  button.dispatchEvent(new Event("scroll"));
  button.dispatchEvent(new Event("wheel"));
  expect(open).not.toHaveBeenCalled();
  button.dispatchEvent(new Event("click"));
  expect(open).toHaveBeenCalledTimes(1);
});

test("maps chapter and bibliography offsets separately, picks nearest known structure and rejects stale revisions", (): void => {
  const paper = projectFixture();
  const first: SourceTarget = {id: "proof", chapterId: "proof", kind: "heading", from: 0, to: 5, source: "chapter"};
  const theorem: SourceTarget = {...first, id: "thm:main", kind: "theorem", from: 13, to: 36};
  const book: SourceTarget = {...first, id: "bib-example", kind: "bibliography", source: "bibliography", to: 8};
  const result: RenderSuccess = {id: "one", revision: paper.revision, pages: [{id: "proof", title: "Proof", html: "", targets: [book, first, theorem]}]};
  expect(locatePreview("chapters/a-proof.md", 0, result, paper)).toEqual(first);
  expect(locatePreview("chapters/a-proof.md", 12, result, paper)).toEqual(theorem);
  expect(locatePreview("references.yaml", 0, result, paper)).toEqual(book);
  expect(targetPath(book, paper)).toEqual("references.yaml");
  expect(locatePreview("chapters/a-proof.md", 0, {...result, revision: "older"}, paper)).toBeNull();
  expect(locatePreview("chapters/z-intro.md", 0, result, paper)).toBeNull();
});

test("raw offsets preserve astral characters and mixed-newline boundaries", (): void => {
  const raw = rawCoordinates("😀\r\nx\ny\r\nz");
  expect([0, 2, 3, 5, 6, 7, 8].map(raw)).toEqual([0, 2, 4, 6, 7, 9, 10]);
});
