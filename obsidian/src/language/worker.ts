import { citationImpact, previewCitationRename, validateNewCitationKey } from "../bibliography/rename";
import { previewTitle } from "./title-preview";
import { inspectChapter } from "../../../editor/chapter-title.js";
import { analyzeWriting, projectLabels, type SourceAnalysisCache } from "./analysis";
import { suggestionsFor } from "./completion";
import type { LanguageRequest, LanguageResponse } from "./worker-protocol";

interface WorkerScope {
  addEventListener(type: "message", listener: (event: MessageEvent<LanguageRequest>) => void): void;
  postMessage(response: LanguageResponse): void;
}

const port = globalThis as unknown as WorkerScope;
const cache: SourceAnalysisCache = new Map();

port.addEventListener("message", ({ data: request }: MessageEvent<LanguageRequest>): void => {
  let response: LanguageResponse;
  try {
    switch (request.kind) {
      case "validateCitationKey":
        validateNewCitationKey(request.value.project, request.value.key);
        response = { id: request.id, kind: "validateCitationKey", value: undefined };
        break;
      case "citationImpact":
        response = { id: request.id, kind: "citationImpact", value: citationImpact(request.value.project, request.value.key) };
        break;
      case "citationRename":
        response = { id: request.id, kind: "citationRename",
          value: previewCitationRename(request.value.project, request.value.from, request.value.to) };
        break;
      case "previewTitle":
        response = {id: request.id, kind: "previewTitle", value: previewTitle(request.value.source, request.value.title)};
        break;
      case "title":
        response = { id: request.id, kind: "title", value: inspectChapter(request.value).title };
        break;
      case "analyze":
        response = { id: request.id, kind: "analyze", value: analyzeWriting(request.value, cache) };
        break;
      case "complete": {
        const { context, project } = request.value;
        const labels = project ? projectLabels(project, cache) : [];
        response = {
          id: request.id, kind: "complete",
          value: suggestionsFor(context, { revision: project?.revision ?? "", labels, diagnostics: [] }),
        };
        break;
      }
    }
  } catch (error: unknown) {
    response = { id: request.id, kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(response);
});
