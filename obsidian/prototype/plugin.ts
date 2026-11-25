import {
  DiagramCache,
  isCacheRequest,
  type CacheRequest,
} from "../../packages/peerpedia-renderer/browser/diagram-cache";
import {
  Plugin,
  ItemView,
  type WorkspaceLeaf,
  FileSystemAdapter,
  sanitizeHTMLToDom,
} from "obsidian";
import { join } from "node:path";
import {
  openSync,
  closeSync,
  writeSync,
  ftruncateSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { AnchoredFiles } from "../src/project/anchored-files";
import { articleFragment } from "../src/preview/article";
declare const __PREVIEW_SOURCE__: string;
declare const __THEME__: string;
interface Result {
  pages: { id: string; html: string }[];
  targets: unknown[];
}
class Preview extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: Prototype,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return "peerpedia-community-prototype";
  }
  getDisplayText(): string {
    return "Peerpedia prototype";
  }
  async onOpen(): Promise<void> {
    this.plugin.paint(this.contentEl);
  }
}
export default class Prototype extends Plugin {
  private readonly diagrams = new DiagramCache();
  private worker?: Worker;
  private serial = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Result) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  result?: Result;
  onload(): void {
    this.registerView(
      "peerpedia-community-prototype",
      (leaf: WorkspaceLeaf): Preview => new Preview(leaf, this),
    );
  }
  render(input: unknown): Promise<Result> {
    if (!this.worker) {
      const url = URL.createObjectURL(
        new Blob([__PREVIEW_SOURCE__], { type: "text/javascript" }),
      );
      this.worker = new Worker(url);
      URL.revokeObjectURL(url);
      const worker = this.worker;
      worker.onmessage = (
        event: MessageEvent<
          { id: number; result: Result; error?: string } | CacheRequest
        >,
      ): void => {
        if (this.worker !== worker) return;
        if (isCacheRequest(event.data)) {
          const message = event.data;
          if (message.operation === "set")
            this.diagrams.set(message.key, message.value!);
          this.worker?.postMessage({
            channel: message.channel,
            id: message.id,
            value:
              message.operation === "get"
                ? this.diagrams.get(message.key)
                : undefined,
          });
          return;
        }
        const pending = this.pending.get(event.data.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(event.data.id);
        if (event.data.error) pending.reject(new Error(event.data.error));
        else {
          this.result = event.data.result;
          pending.resolve(event.data.result);
        }
      };
      this.worker.onerror = (event: ErrorEvent): void => {
        event.preventDefault();
        this.stop(new Error(event.message));
      };
    }
    const id = ++this.serial;
    return new Promise(
      (
        resolve: (value: Result) => void,
        reject: (error: Error) => void,
      ): void => {
        const timer = setTimeout(
          (): void => this.stop(new Error("Prototype renderer timed out")),
          40000,
        );
        this.pending.set(id, { resolve, reject, timer });
        this.worker!.postMessage({ id, input });
      },
    );
  }
  async show(): Promise<void> {
    const leaf = this.app.workspace.getLeaf("split");
    await leaf.setViewState({
      type: "peerpedia-community-prototype",
      active: true,
    });
  }
  paint(container: HTMLElement): void {
    const frame = container.createEl("iframe", {
      cls: "peerpedia-prototype-frame",
      attr: { sandbox: "allow-same-origin", title: "Offline manuscript" },
    });
    frame.onload = (): void => {
      const doc = frame.contentDocument!;
      const style = doc.createElement("style");
      style.textContent = __THEME__;
      doc.head.append(style);
      const article = doc.createElement("article");
      article.className = "peerpedia-article peerpedia-theme-tokens";
      for (const page of this.result?.pages ?? [])
        article.append(articleFragment(doc, sanitizeHTMLToDom(page.html)));
      doc.body.append(article);
    };
    frame.srcdoc =
      "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none';script-src 'none';style-src 'unsafe-inline';font-src data:;base-uri 'none';form-action 'none'\"><body></body>";
  }
  async safeWriteProbe(): Promise<object> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter))
      throw new Error("Desktop vault required");
    const tree = AnchoredFiles.open(adapter.getBasePath());
    try {
      await tree.mkdir(".safe-write-probe");
      tree.lockProject(".safe-write-probe");
      await tree.file(".safe-write-probe/a.md", "original");
      await tree.file(".safe-write-probe/b.md", "replacement");
      const old = openSync(
        join(adapter.getBasePath(), ".safe-write-probe/a.md"),
        "r+",
      );
      try {
        tree.rename(".safe-write-probe/a.md", ".safe-write-probe/b.md", "swap");
        const a = await tree.source(".safe-write-probe/a.md"),
          b = await tree.source(".safe-write-probe/b.md");
        ftruncateSync(old, 0);
        writeSync(old, "late external", 0, "utf8");
        const preserved = await tree.source(".safe-write-probe/b.md");
        const folder = join(adapter.getBasePath(), ".safe-write-probe");
        renameSync(folder, folder + "-displaced");
        mkdirSync(folder);
        let rejected = false;
        try {
          await tree.file(".safe-write-probe/blocked.md", "must not write");
        } catch (error: unknown) {
          rejected =
            error instanceof Error &&
            error.message.includes("moved or replaced");
        }
        return {
          a: a?.text,
          b: b?.text,
          lateWrite: preserved?.text,
          directoryReplacementRejected: rejected,
        };
      } finally {
        closeSync(old);
      }
    } finally {
      tree.close();
    }
  }
  private stop(error: Error): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
  }
  onunload(): void {
    this.diagrams.clear();
    this.stop(new Error("Prototype unloaded"));
  }
}
