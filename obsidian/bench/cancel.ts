import {
  PreviewController,
  type PreviewRenderer,
} from "../src/preview/controller";
import type { PublicationDocument } from "../src/project/document";
import type { RenderRequest, RenderResponse } from "../renderer/protocol";
import { toPublicationDocument } from "../src/project/publication";
import type { ProjectSnapshot } from "../src/project/types";
import { BrowserRendererClient } from "../src/preview/browser-renderer-client";

import { makeProject, edit } from "./fixture";
export async function cancellation(): Promise<Record<string, unknown>[]> {
  const results: Record<string, unknown>[] = [];
  const client = new BrowserRendererClient();
  let started = 0,
    cancelled = 0,
    completed = 0;
  const renderer: PreviewRenderer = {
    async convert(
      project: ProjectSnapshot,
      _signal: AbortSignal,
    ): Promise<PublicationDocument> {
      return toPublicationDocument(project);
    },
    async render(
      request: RenderRequest,
      signal: AbortSignal,
    ): Promise<RenderResponse> {
      started++;
      const response = await client.render(request, signal);
      if (signal.aborted) cancelled++;
      else completed++;
      return response;
    },
  };
  const controller = new PreviewController(renderer, (): void => {});
  try {
    let project = makeProject(64);
    const start = performance.now();
    for (let i = 0; i < 8; i++) {
      project = edit(project);
      controller.update(project);
      await new Promise<void>((resolve: () => void): void => {
        setTimeout(resolve, 650);
      });
    }
    results.push({
      phase: "typing",
      elapsedMs: Math.round(performance.now() - start),
      started,
      cancelled,
      completed,
      busy: controller.state().busy,
    });
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 4000);
    });
    results.push({
      phase: "afterPause",
      elapsedMs: Math.round(performance.now() - start),
      started,
      cancelled,
      completed,
      busy: controller.state().busy,
      error: controller.state().error,
    });
    return results;
  } finally {
    controller.dispose();
    await client.dispose();
  }
}
