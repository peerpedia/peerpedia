import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { failure, isRecord, type RenderRequest, type RenderResponse } from "../../renderer/protocol";

const REQUEST_TIMEOUT_MS = 40_000;

interface RendererOptions {
  runtimePath: string;
  cachePath?: string;
  timeoutMs?: number;
}

interface Pending {
  request: RenderRequest;
  finish: (response: RenderResponse) => void;
}

interface Worker {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  stopping: boolean;
  error?: string;
  stderr: string;
}

export class RendererClient {
  readonly #runtimePath: string;
  readonly #cachePath: string;
  readonly #timeoutMs: number;
  #disposed = false;
  #worker?: Worker;
  #active?: Pending;
  readonly #queue: Pending[] = [];

  constructor(options: RendererOptions) {
    this.#runtimePath = resolve(options.runtimePath);
    this.#cachePath = resolve(options.cachePath ?? join(homedir(), "Library/Caches/Peerpedia/Obsidian/tikz"));
    this.#timeoutMs = Math.min(options.timeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS);
  }

  render(request: RenderRequest, signal: AbortSignal): Promise<RenderResponse> {
    if (this.#disposed) return Promise.resolve(failure(request, "Renderer disposed."));
    if (signal.aborted) return Promise.resolve(failure(request, "Rendering cancelled."));

    return new Promise((settle: (response: RenderResponse) => void): void => {
      const abort = (): void => this.#cancel(pending, "Rendering cancelled.");
      const timer = setTimeout((): void => {
        this.#cancel(pending, `Rendering timed out after ${this.#timeoutMs / 1000} seconds.`);
      }, this.#timeoutMs);
      const pending: Pending = {
        request,
        finish(response: RenderResponse): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          settle(response);
        },
      };
      signal.addEventListener("abort", abort, { once: true });
      this.#queue.push(pending);
      this.#pump();
    });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const pending of this.#queue.splice(0)) pending.finish(failure(pending.request, "Renderer disposed."));
    if (this.#active) this.#cancel(this.#active, "Renderer disposed.");
    const worker = this.#worker;
    if (worker) {
      this.#stop(worker);
      await worker.closed;
    }
  }

  #pump(): void {
    if (this.#disposed || this.#active || this.#worker?.stopping) return;
    const pending = this.#queue.shift();
    if (!pending) return;
    this.#active = pending;
    try {
      const worker = this.#worker ?? this.#start();
      worker.child.stdin.write(JSON.stringify(pending.request) + "\n");
    } catch (error: unknown) {
      this.#cancel(pending, error instanceof Error ? error.message : String(error));
    }
  }

  #start(): Worker {
    const child = spawn(join(this.#runtimePath, "bin/node"), [join(this.#runtimePath, "renderer.mjs")], {
      cwd: this.#runtimePath,
      env: { PATH: "", BANANAMARK_CACHE: this.#cachePath },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let close!: () => void;
    const worker: Worker = {
      child,
      closed: new Promise((resolveClose: () => void): void => { close = resolveClose; }),
      stopping: false,
      stderr: "",
    };
    this.#worker = worker;
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", (line: string): void => this.#receive(worker, line));
    child.stderr.setEncoding("utf8").on("data", (chunk: string): void => {
      worker.stderr = (worker.stderr + chunk).slice(-2000);
    });
    child.on("error", (error: Error): void => {
      worker.error ??= error.message;
      this.#stop(worker);
    });
    child.stdin.on("error", (error: Error): void => {
      // A process that exits while stdin is being written may produce EPIPE before its exit status.
      if ((error as NodeJS.ErrnoException).code === "EPIPE") return;
      worker.error ??= error.message;
      this.#stop(worker);
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null): void => {
      output.close();
      this.#worker = undefined;
      const active = this.#active;
      this.#active = undefined;
      if (active) {
        const reason = worker.error ?? `Renderer exited (${signal ?? `code ${code}`}).`;
        const detail = worker.stderr.trim();
        active.finish(failure(active.request, detail ? `${reason}\n${detail}` : reason));
      }
      close();
      this.#pump();
    });
    return worker;
  }

  #receive(worker: Worker, line: string): void {
    const active = this.#active;
    if (worker.stopping || !active) return;
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      this.#cancel(active, "Renderer sent invalid JSON.");
      return;
    }
    if (!isRecord(response) || response.id !== active.request.id || response.revision !== active.request.revision ||
      !(Array.isArray(response.pages) || (isRecord(response.error) && typeof response.error.message === "string"))) {
      this.#cancel(active, "Renderer sent an invalid or mismatched response.");
      return;
    }
    this.#active = undefined;
    active.finish(response as unknown as RenderResponse);
    this.#pump();
  }

  #cancel(pending: Pending, message: string): void {
    if (pending === this.#active) {
      this.#active = undefined;
      if (this.#worker) this.#stop(this.#worker);
    } else {
      const index = this.#queue.indexOf(pending);
      if (index < 0) return;
      this.#queue.splice(index, 1);
    }
    pending.finish(failure(pending.request, message));
    this.#pump();
  }

  #stop(worker: Worker): void {
    if (worker.stopping) return;
    worker.stopping = true;
    if (worker.child.pid !== undefined) worker.child.kill("SIGKILL");
  }
}
