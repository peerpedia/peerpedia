import { articleLink, localTheme, type PreviewTheme } from "../src/preview/article";
import { afterEach, expect, test, vi } from "vitest";
import type { RenderRequest, RenderResponse } from "../renderer/protocol";
import { PreviewController } from "../src/preview/controller";
import { toPublicationDocument } from "../src/project/document";
import type { ProjectSnapshot } from "../src/project/types";
import { projectFixture } from "./fixtures";

function harness(): {
  controller: PreviewController;
  pending: { request: RenderRequest; signal: AbortSignal; finish: (response: RenderResponse) => void }[];
} {
  vi.useFakeTimers();
  const pending: ReturnType<typeof harness>["pending"] = [];
  const controller = new PreviewController({
    convert: async (project: ProjectSnapshot): Promise<ReturnType<typeof toPublicationDocument>> => toPublicationDocument(project),
    render: (request: RenderRequest, signal: AbortSignal): Promise<RenderResponse> =>
      new Promise((finish: (response: RenderResponse) => void): void => { pending.push({ request, signal, finish }); }),
    dispose: async (): Promise<void> => {},
  }, (): void => {});
  return { controller, pending };
}

afterEach((): void => { vi.useRealTimers(); });

test("debounces 300ms, renders the ordered whole paper, and ignores a cancelled older response arriving last", async (): Promise<void> => {
  const { controller, pending } = harness();
  const paper = projectFixture();
  controller.update({ ...paper, revision: "discarded" });
  controller.update({ ...paper, revision: "A" });
  await vi.advanceTimersByTimeAsync(299);
  expect(pending).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  expect(pending[0].request.document).toEqual(toPublicationDocument(paper));
  controller.update({ ...paper, revision: "B" });
  expect(pending[0].signal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  pending[1].finish({ ...pending[1].request, pages: [] });
  await vi.advanceTimersByTimeAsync(0);
  pending[0].finish({ ...pending[0].request, pages: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.state()).toMatchObject({ currentRevision: "B", renderedRevision: "B", result: {revision: "B"}, busy: false });
  await controller.dispose();
});

test("first failure is empty and later failures retain the last good revision", async (): Promise<void> => {
  const { controller, pending } = harness();
  const paper = projectFixture();
  for (const revision of ["bad", "good", "broken"]) {
    controller.update({ ...paper, revision });
    await vi.advanceTimersByTimeAsync(300);
    const item = pending.at(-1)!;
    item.finish(revision === "good" ? { ...item.request, pages: [] } : { ...item.request, error: { message: revision } });
    await vi.advanceTimersByTimeAsync(0);
    if (revision === "bad") expect(controller.state()).toMatchObject({ result: null, renderedRevision: null, error: {message: "bad"} });
  }
  expect(controller.state()).toMatchObject({currentRevision: "broken", renderedRevision: "good", result: {revision: "good"}, error: {message: "broken"}});
  controller.update({ ...paper, revision: "closing" });
  await controller.dispose();
  await vi.advanceTimersByTimeAsync(500);
  expect(pending).toHaveLength(3);
});

test("resource adaptation accepts only declared local font files and user-activated web or mail links", (): void => {
  const manifest = {stylesheet: "style.css", katex: {fonts: ["fonts/katex/KaTeX_Main.woff2"]}, tikz: {fonts: ["tikz/cmr10.ttf"]}};
  const local = (path: string): string => "app://vault/local/theme/" + path;
  expect(localTheme(manifest, local).katex.get("./fonts/katex/KaTeX_Main.woff2")).toBe(local(manifest.katex.fonts[0]));
  expect(localTheme(manifest, local).fonts).toContain(local(manifest.tikz.fonts[0]));
  expect((): PreviewTheme => localTheme(manifest, (path: string): string => "https://example.invalid/" + path)).toThrow();
  expect((): PreviewTheme => localTheme({...manifest, tikz: {fonts:["../other.ttf"]}}, local)).toThrow();
  expect(articleLink("https://example.invalid/test")).toBe("https://example.invalid/test");
  expect(articleLink("?chapter=intro#eq:main")).toBe("?chapter=intro#eq:main");
  for (const link of ["file:///elsewhere", "obsidian://open", "javascript:void(0)", "//example.invalid/x"]) expect(articleLink(link)).toBeNull();
});
