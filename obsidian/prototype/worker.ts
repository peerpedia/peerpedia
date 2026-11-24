// The website implementation is bundled directly; no second renderer implementation.
import { renderDocument } from "../../packages/peerpedia-renderer/browser/entry";
self.onmessage = async (event: MessageEvent): Promise<void> => {
  try {
    self.postMessage({
      id: event.data.id,
      result: await renderDocument(event.data.input),
    });
  } catch (error: unknown) {
    self.postMessage({
      id: event.data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
