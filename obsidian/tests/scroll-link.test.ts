import { expect, test, vi } from "vitest";
import type { RenderSuccess, SourceTarget } from "../renderer/protocol";
import { bindSourceButton, locatePreview, previewMember, rawCoordinates, targetPath, viewportTarget } from "../src/preview/source-map";
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

test("viewport navigation distinguishes a heading at the reading line from a distant nearest structure", (): void => {
  const first: SourceTarget = {id:"first", chapterId:"intro", kind:"heading", source:"chapter", from:0, to:4};
  const last: SourceTarget = {...first, id:"last", from:200, to:205};
  const targets = [first, last];
  const locate = (a: number, b: number): ReturnType<typeof viewportTarget> =>
    viewportTarget(targets, (id: string): {top: number; bottom: number} => {
      const top = id === "first" ? a : b;
      return {top, bottom: top + 20};
    });
  expect(locate(-900, 780)).toEqual({target:last, exact:false});
  expect(locate(-4, 1000)).toEqual({target:first, exact:true});
  expect(locate(-400, 12)).toEqual({target:last, exact:true});
  expect(viewportTarget(targets, (_id: string): null => null)).toEqual({target:null, exact:false});
});

test("an NFD native editor path resolves to the declared NFC chapter spelling", (): void => {
  const project = projectFixture();
  const file = {...project.files[1], path:"é.md"};
  expect(previewMember({...project, files:[file]}, "paper/e\u0301.md")).toBe(file);
  expect(previewMember({...project, files:[file]}, "other/e\u0301.md")).toBeUndefined();
});
