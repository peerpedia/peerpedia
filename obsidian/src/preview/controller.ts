import type { RenderFailure, RenderRequest, RenderResponse } from "../../renderer/protocol";
import type { PublicationDocument } from "../project/document";
import type { ProjectSnapshot } from "../project/types";
import { emptyPreview, type PreviewState } from "./state";

export interface PreviewRenderer {
  convert(project: ProjectSnapshot, signal: AbortSignal): Promise<PublicationDocument>;
  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResponse>;
  dispose(): Promise<void>;
}

export class PreviewController {
  private value = emptyPreview();
  private timer?: ReturnType<typeof setTimeout>;
  private active?: AbortController;
  private disposed = false;
  private sequence = 0;

  constructor(private readonly renderer: PreviewRenderer, private readonly changed: () => void) {}

  state(): PreviewState { return this.value; }

  update(project: ProjectSnapshot): void {
    if (this.disposed || project.revision === this.value.currentRevision) return;
    this.cancel();
    if (project.revision === this.value.renderedRevision) {
      this.value = { ...this.value, currentRevision: project.revision, busy: false, error: null };
    } else {
      this.value = { ...this.value, currentRevision: project.revision, busy: true, error: null };
      const active = new AbortController();
      this.active = active;
      this.timer = setTimeout((): void => { void this.run(project, active); }, 300);
    }
    this.changed();
  }

  unavailable(error: RenderFailure["error"]): void {
    if (this.disposed) return;
    this.cancel();
    this.value = { ...this.value, currentRevision: "", error, busy: false };
    this.changed();
  }

  private async run(project: ProjectSnapshot, active: AbortController): Promise<void> {
    const revision = project.revision;
    const signal = active.signal;
    try {
      const document = await this.renderer.convert(project, signal);
      if (signal.aborted) return;
      const id = String(++this.sequence);
      const response = await this.renderer.render({ id, revision, document }, signal);
      if (signal.aborted) return;
      if (response.id !== id || response.revision !== revision) throw new Error("预览修订不匹配。");
      this.value = "error" in response ? { ...this.value, error: response.error, busy: false }
        : { ...this.value, result: response, renderedRevision: revision, busy: false };
    } catch (error: unknown) {
      if (signal.aborted) return;
      this.value = { ...this.value, busy: false, error: { message: error instanceof Error ? error.message : String(error) } };
    }
    this.active = undefined;
    this.changed();
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.active?.abort();
    this.active = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    await this.renderer.dispose();
  }
}
