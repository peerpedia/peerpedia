import { setTimeout, clearTimeout } from "node:timers";
import {failure, isRecord, type RenderRequest, type RenderResponse} from "../../renderer/protocol";

declare const __PEERPEDIA_RENDERER_WORKER__: string;
export interface RenderWorker {
  onmessage: ((event: MessageEvent<RenderResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(request: RenderRequest): void;
  terminate(): void;
}
export interface RenderService {
  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResponse>;
}
interface Pending { request: RenderRequest; finish(response: RenderResponse): void }

function createWorker(): RenderWorker {
  const url = URL.createObjectURL(new Blob([__PEERPEDIA_RENDERER_WORKER__], {type:"text/javascript"}));
  try { return new Worker(url); } finally { URL.revokeObjectURL(url); }
}

/** One plugin-owned queue; cancellation belongs to a request, never to a view or project ID. */
export class BrowserRendererClient implements RenderService {
  private worker?: RenderWorker;
  private active?: Pending;
  private readonly queue: Pending[] = [];
  private disposed = false;
  private idle?: ReturnType<typeof setTimeout>;
  private readonly timeout: number;
  private readonly idleMs: number;
  private readonly factory: () => RenderWorker;

  constructor(options: {createWorker?:()=>RenderWorker; timeoutMs?:number; idleMs?:number} = {}) {
    this.factory = options.createWorker ?? createWorker;
    this.timeout = Math.min(options.timeoutMs ?? 40_000, 40_000);
    this.idleMs = options.idleMs ?? 30_000;
  }

  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResponse> {
    if (this.disposed || signal.aborted) return Promise.resolve(failure(request, "Rendering cancelled."));
    return new Promise((resolve: (response: RenderResponse) => void): void => {
      const abort = (): void => this.cancel(pending, "Rendering cancelled.");
      const timer = setTimeout((): void => this.cancel(pending, "Rendering timed out."), this.timeout);
      const pending: Pending = {request, finish(response: RenderResponse): void {
        clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(response);
      }};
      signal.addEventListener("abort", abort, {once:true});
      this.queue.push(pending);
      this.pump();
    });
  }

  private pump(): void {
    if (this.disposed || this.active) return;
    clearTimeout(this.idle);
    const pending = this.queue.shift();
    if (!pending) {
      if (this.worker) this.idle = setTimeout((): void => this.stop(), this.idleMs);
      return;
    }
    this.active = pending;
    try {
      if (!this.worker) {
        const worker = this.factory();
        this.worker = worker;
        worker.onmessage = (event: MessageEvent<RenderResponse>): void => {
          if (this.worker !== worker || !this.active) return;
          const current = this.active, response: unknown = event.data;
          if (!isRecord(response) || response.id !== current.request.id || response.revision !== current.request.revision ||
            !(Array.isArray(response.pages) || (isRecord(response.error) && typeof response.error.message === "string"))) {
            this.cancel(current, "The local renderer returned an invalid response."); return;
          }
          this.active = undefined;
          current.finish(response as unknown as RenderResponse);
          this.pump();
        };
        worker.onerror = (event: ErrorEvent): void => {
          event.preventDefault();
          if (this.worker === worker && this.active) this.cancel(this.active, "The local renderer could not complete this request.");
        };
      }
      this.worker.postMessage(pending.request);
    } catch { this.cancel(pending, "Unable to start the local renderer."); }
  }

  private cancel(pending: Pending, message: string): void {
    if (this.active === pending) { this.active = undefined; this.stop(); }
    else {
      const index = this.queue.indexOf(pending);
      if (index < 0) return;
      this.queue.splice(index, 1);
    }
    pending.finish(failure(pending.request, message));
    this.pump();
  }

  private stop(): void {
    clearTimeout(this.idle);
    this.worker?.terminate(); this.worker = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.active) this.cancel(this.active, "Renderer disposed.");
    for (const pending of this.queue.splice(0)) pending.finish(failure(pending.request, "Renderer disposed."));
    this.stop();
  }
}
