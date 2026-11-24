declare const __TIKZ_WORKER__: string;
type Listener = (value: unknown) => void;
export const threadId = 1;
export const parentPort = {
  on(event: string, listener: Listener): void {
    if (event !== "message") throw new Error("Unsupported parent event");
    self.addEventListener("message", (message: MessageEvent): void =>
      listener(message.data),
    );
  },
  postMessage(value: unknown): void {
    self.postMessage(value);
  },
};
export class Worker {
  private readonly worker: globalThis.Worker;
  private readonly listeners = new Map<string, Set<Listener>>();
  constructor(url: URL) {
    if (!url.pathname.endsWith("/worker.mjs"))
      throw new Error("Unexpected worker source");
    const blob = URL.createObjectURL(
      new Blob([__TIKZ_WORKER__], { type: "text/javascript" }),
    );
    this.worker = new globalThis.Worker(blob);
    URL.revokeObjectURL(blob);
    this.worker.onmessage = (event: MessageEvent): void =>
      this.emit("message", event.data);
    this.worker.onerror = (event: ErrorEvent): void => {
      event.preventDefault();
      this.emit("error", new Error(event.message));
    };
  }
  private emit(event: string, value: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      this.listeners.get(event)?.delete(listener);
      listener(value);
    }
  }
  once(event: string, listener: Listener): void {
    // Store the original identity so the upstream cleanup's off() removes this listener.
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }
  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }
  postMessage(value: unknown): void {
    this.worker.postMessage(value);
  }
  unref(): void {
    /* Browser workers do not keep a Node process alive. */
  }
  async terminate(): Promise<number> {
    this.worker.terminate();
    this.listeners.clear();
    return 0;
  }
}
