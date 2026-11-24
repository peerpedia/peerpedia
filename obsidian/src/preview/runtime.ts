import { LanguageWorker } from "../host/language-worker";
import type { PublicationDocument } from "../project/publication";
import type { ProjectSnapshot } from "../project/types";
import type { RenderRequest, RenderResponse } from "../../renderer/protocol";
import type { PreviewRenderer } from "./controller";
import { RendererClient } from "./renderer-client";

export function previewRenderer(runtimePath: string): PreviewRenderer {
  const client = new RendererClient({ runtimePath });
  let worker: LanguageWorker | undefined;
  const stop = (): void => { worker?.dispose(); worker = undefined; };
  return {
    async convert(project: ProjectSnapshot, signal: AbortSignal): Promise<PublicationDocument> {
      worker ??= new LanguageWorker();
      signal.addEventListener("abort", stop, {once: true});
      try { return await worker.run("publication", project); }
      finally { signal.removeEventListener("abort", stop); }
    },
    render(request: RenderRequest, signal: AbortSignal): Promise<RenderResponse> { return client.render(request, signal); },
    async dispose(): Promise<void> { stop(); await client.dispose(); },
  };
}
