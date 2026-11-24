import { previewTitle } from "../src/language/title-preview";
import { FormRequest } from "../src/ui/form-request";
import { expect, test } from "vitest";
import { changeMembership, chapterTitleEdit, newPaper, reorderChapter } from "../src/project/management";
import { moveScope } from "../src/host/file-events";
import { projectFixture } from "./fixtures";

test("panel changes order and removes membership without deleting source; callbacks retain their starting revision", (): void => {
  const paper = projectFixture();
  const [intro, proof] = paper.config.chapters!;
  const order = reorderChapter(paper, intro.id, 1);
  expect(order.beforeDigest).toBe(paper.files[0].digest);
  expect(JSON.parse(order.afterText!).chapters).toEqual([proof, intro]);
  const removed = changeMembership(paper, [proof]);
  expect(removed.path).toBe("paper.json");
  expect(JSON.parse(removed.afterText!).chapters).toEqual([proof]);
});

test("single and chaptered project templates and source title preview match what will be written", (): void => {
  expect(newPaper("论文", false).map((f: {path: string}): string => f.path)).toContain("paper.md");
  const paper = projectFixture();
  expect(JSON.parse(newPaper("论文", true)[0].afterText!).chapters).toHaveLength(1);
  const edit = chapterTitleEdit(paper, paper.config.chapters![0], previewTitle(paper.files[1].text,"新章名"));
  expect(edit[0].afterText).toBe("# 新章名 {@sec:intro}\r\n\r\n正文 😀\r\n");
  expect(JSON.parse(edit[1].afterText!).chapters[0]).toMatchObject({ id: "intro", title: "新章名" });
});

test("moving a folder moves folder and per-file overrides without touching siblings", (): void => {
  expect(moveScope({ folders: { old: true, "old/sub": false, older: true }, files: { "old/x.md": false } },
    "old", "new")).toEqual({ folders: { new: true, "new/sub": false, older: true }, files: { "new/x.md": false } });
});

test("a new edit, a newer preview, closing the form and a changed project each invalidate asynchronous form output", (): void => {
  const work = new FormRequest();
  let current = true;
  const check = (): boolean => current;
  const initial = work.begin(check);
  const preview = work.begin(check);
  expect(initial()).toBe(false);
  work.cancel();
  expect(preview()).toBe(false);
  const latest = work.begin(check);
  expect(latest()).toBe(true);
  current = false;
  expect(latest()).toBe(false);
});
test.each(["## Original {@sec:old}*", "## Original* {@sec:old .red}", "## Original {@sec:old .red}", "##  Original   ##", "Original {@sec:old}*\r\n-----"])(
  "changing the visible title preserves the source delimiters in %s", (heading: string): void => {
    const source = "\uFEFF" + heading + "\r\n\r\nBody\r\n";
    expect(previewTitle(source, "Revised").text).toBe(source.replace("Original", "Revised"));
  });
