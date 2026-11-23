import type { RenderPage, SourceTarget } from "../../renderer/protocol";
import { articleFragment, type PreviewTheme } from "./article";

const frameDocument = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src app:; base-uri 'none'; form-action 'none'">
<style>html{background:white}body{margin:0 auto;padding:1.5rem;max-width:48rem}</style>
</head><body><article class="peerpedia-article peerpedia-theme-tokens"></article></body></html>`;

function installTheme(doc: Document, theme: PreviewTheme, css: string): void {
  // Obsidian's CSP permits inline styles but denies a link to its local resource host.
  // Parse the installed sheet and adapt only the packaged font-face URL descriptors.
  const sheet = new doc.defaultView!.CSSStyleSheet();
  sheet.replaceSync(css);
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
    const face = rule as CSSFontFaceRule;
    const sources = face.style.getPropertyValue("src").split(",").map((item: string): string => {
      const descriptor = /^url\("([^"]+)"\) format\("(woff2?|truetype)"\)$/.exec(item.trim());
      const url = descriptor && theme.katex.get(descriptor[1]);
      if (!url) throw new Error("公式字体缺少本地资源。");
      return `url(${JSON.stringify(url)}) format("${descriptor[2]}")`;
    });
    face.style.setProperty("src", sources.join(", "));
  }
  const fonts = new doc.defaultView!.CSSStyleSheet();
  fonts.replaceSync(theme.fonts);
  doc.adoptedStyleSheets = [sheet, fonts];
}

/** Only the host can write into the frame. Every installed stylesheet is from the local theme. */
export class PreviewReader {
  private article?: HTMLElement;
  private page?: RenderPage;
  private anchor: string | null = null;
  private anchoredScroll = 0;

  constructor(frame: HTMLIFrameElement, theme: PreviewTheme, css: string, link: (value: string) => void, unavailable: () => void) {
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.addEventListener("load", (): void => {
      const doc = frame.contentDocument;
      const article = doc?.querySelector("article");
      if (!doc || !article) return;
      this.article = article;
      try { installTheme(doc, theme, css); }
      catch { unavailable(); return; }
      article.addEventListener("click", (event: MouseEvent): void => {
        const anchor = (event.target as Element | null)?.closest?.("a[data-preview-link]");
        if (!anchor) return;
        event.preventDefault();
        if (event.isTrusted) link(anchor.getAttribute("data-preview-link")!);
      });
      this.paint();
    });
    frame.srcdoc = frameDocument;
  }

  show(page: RenderPage): void {
    if (page === this.page) return;
    this.page = page;
    this.anchor = null;
    this.paint();
  }

  scroll(id: string | null): boolean {
    this.anchor = id;
    const doc = this.article?.ownerDocument;
    const target = id ? doc?.getElementById(id) : this.article;
    if (target) {
      target.scrollIntoView({block: "start"});
      this.anchoredScroll = doc?.scrollingElement?.scrollTop ?? 0;
    }
    return Boolean(target) || !doc;
  }

  /** Determine intent at button-click time, without a scroll listener or a write to the editing pane. */
  visibleTarget(): SourceTarget | null {
    const doc = this.article?.ownerDocument;
    if (!doc || !this.page) return null;
    // An explicit reference may land near the bottom of a short page, where its
    // viewport top cannot reach the target. Remember that anchor until the reader scrolls.
    if (this.anchor && doc.scrollingElement?.scrollTop === this.anchoredScroll) {
      const selected = this.page.targets.find((target: SourceTarget): boolean => target.id === this.anchor);
      if (selected && doc.getElementById(selected.id)) return selected;
    }
    let nearest: SourceTarget | null = null;
    let distance = Infinity;
    for (const target of this.page.targets) {
      const el = doc.getElementById(target.id);
      if (!el) continue;
      const gap = Math.abs(el.getBoundingClientRect().top - 12);
      if (gap < distance) { nearest = target; distance = gap; }
    }
    return nearest;
  }

  private paint(): void {
    if (!this.page || !this.article) return;
    this.article.replaceChildren(articleFragment(this.article.ownerDocument, this.page.html));
    this.scroll(this.anchor);
  }
}
