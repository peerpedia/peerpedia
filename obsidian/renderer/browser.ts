import { renderDocument } from "../../packages/peerpedia-renderer/browser/entry";
import { renderRequest } from "./render-request";
import type { RenderRequest } from "./protocol";

self.onmessage = async (event: MessageEvent<RenderRequest>): Promise<void> => {
  self.postMessage(await renderRequest(event.data, renderDocument));
};
