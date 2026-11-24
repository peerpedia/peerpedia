import { expect, test } from "vitest";
import { WorkspaceContext } from "../src/ui/workspace-context";

test("a slow previous paper lookup cannot replace the most recently opened manuscript", async (): Promise<void> => {
  let finishFirst!: (root: string) => void;
  const first = new Promise<string>((resolve: (root: string) => void): void => { finishFirst = resolve; });
  const selected: string[] = [];
  const context = new WorkspaceContext((path: string): Promise<string | undefined> => path === "a.md" ? first : Promise.resolve("paper-b"),
    async (root: string, path: string): Promise<void> => { selected.push(root + "/" + path); });
  const old = context.follow("a.md");
  await context.follow("b.md");
  finishFirst("paper-a"); await old;
  expect(selected).toEqual(["paper-b/b.md"]);
});

test("unrelated notes invalidate old lookups without selecting a paper", async (): Promise<void> => {
  let finish!: (root: string) => void;
  const pending = new Promise<string>((resolve: (root: string) => void): void => { finish = resolve; });
  const selected: string[] = [];
  const context = new WorkspaceContext((path: string): Promise<string | undefined> => path === "note.md" ? Promise.resolve(undefined) : pending,
    async (root: string): Promise<void> => { selected.push(root); });
  const old = context.follow("chapter.md");
  await context.follow("note.md");finish("paper");await old;
  expect(selected).toEqual([]);
});
