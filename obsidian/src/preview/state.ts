import type { RenderFailure, RenderSuccess } from "../../renderer/protocol";

export interface PreviewState {
  currentRevision: string;
  renderedRevision: string | null;
  result: RenderSuccess | null;
  error: RenderFailure["error"] | null;
  busy: boolean;
}

export function emptyPreview(): PreviewState {
  return { currentRevision: "", renderedRevision: null, result: null, error: null, busy: false };
}
