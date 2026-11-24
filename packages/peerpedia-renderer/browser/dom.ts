import { DOMParser } from "linkedom";
export class JSDOM {
  readonly window: Window & typeof globalThis;
  constructor(source: string, options: { contentType?: string } = {}) {
    const document = new DOMParser().parseFromString(
      source,
      options.contentType === "image/svg+xml" ? "image/svg+xml" : "text/html",
    );
    this.window = document.defaultView;
    Object.defineProperty(this.window, "NodeFilter", {
      value: { SHOW_COMMENT: 128 },
      configurable: true,
    });
  }
}
