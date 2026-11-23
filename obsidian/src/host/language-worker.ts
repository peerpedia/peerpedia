import type { LanguageInputs, LanguageKind, LanguageOutputs, LanguageRequest, LanguageResponse } from "../language/worker-protocol";

declare const __PEERPEDIA_LANGUAGE_WORKER__: string;

interface Pending {
  receive: (message: LanguageResponse) => void;
  reject: (error: Error) => void;
}

export interface LanguageThread {
  onResponse(listener: (response: LanguageResponse) => void): void;
  onFailure(listener: (error: Error) => void): void;
  request(message: LanguageRequest): void;
  close(): void;
}

function browserThread(source: string): LanguageThread {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    const worker = new Worker(url);
    return {
      onResponse(listener: (response: LanguageResponse) => void): void {
        worker.addEventListener("message", (event: MessageEvent<LanguageResponse>): void => listener(event.data));
      },
      onFailure(listener: (error: Error) => void): void {
        worker.addEventListener("error", (event: ErrorEvent): void => {
          event.preventDefault();
          listener(new Error(event.message || "BananaMark language worker could not load."));
        });
        worker.addEventListener("messageerror", (): void => listener(new Error("Unreadable BananaMark language worker reply.")));
      },
      request(message: LanguageRequest): void {
        worker.postMessage(message);
      },
      close(): void {
        worker.terminate();
      },
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class LanguageWorker {
  private thread: LanguageThread | undefined;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private disposed = false;

  constructor(
    private readonly source: string = __PEERPEDIA_LANGUAGE_WORKER__,
    private readonly connect: (source: string) => LanguageThread = browserThread,
  ) {}

  run<K extends LanguageKind>(kind: K, value: LanguageInputs[K]): Promise<LanguageOutputs[K]> {
    if (this.disposed) return Promise.reject(new Error("BananaMark language worker is closed."));
    return new Promise<LanguageOutputs[K]>((resolve: (output: LanguageOutputs[K]) => void, reject: (error: Error) => void): void => {
      const thread = this.thread ?? this.start();
      const id = ++this.sequence;
      this.pending.set(id, {
        receive: (response: LanguageResponse): void => {
          if (response.kind === "error") reject(new Error(response.message));
          else if (response.kind === kind) resolve(response.value as LanguageOutputs[K]);
          else reject(new Error("Unexpected BananaMark language worker reply."));
        },
        reject,
      });
      try {
        thread.request({ id, kind, value } as LanguageRequest);
      } catch (error: unknown) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.thread) this.stop(this.thread, new Error("BananaMark language worker is closed."));
  }

  private start(): LanguageThread {
    const thread = this.connect(this.source);
    this.thread = thread;
    thread.onResponse((response: LanguageResponse): void => {
      if (this.thread !== thread) return;
      const pending = this.pending.get(response.id);
      this.pending.delete(response.id);
      pending?.receive(response);
    });
    thread.onFailure((error: Error): void => this.stop(thread, error));
    return thread;
  }

  private stop(thread: LanguageThread, error: Error): void {
    if (this.thread !== thread) return;
    this.thread = undefined;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    thread.close();
  }
}
