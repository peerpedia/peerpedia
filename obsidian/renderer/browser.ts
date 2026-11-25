import { receiveCacheResponse, type CacheResponse } from "../../packages/peerpedia-renderer/browser/diagram-cache";
import { renderDocument } from "../../packages/peerpedia-renderer/browser/entry";
import { renderRequest } from "./render-request";
import type { RenderRequest } from "./protocol";

self.onmessage = async (event: MessageEvent<RenderRequest | CacheResponse>): Promise<void> => {
  if (receiveCacheResponse(event.data)) return;
  self.postMessage(await renderRequest(event.data as RenderRequest, renderDocument));
};
