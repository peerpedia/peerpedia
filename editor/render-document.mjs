import { createProcessor, defineDialect } from "bananamark";
import { declaredLabels } from "bananamark-codemirror";
import { tikz } from "bananamark-tikz";
import { JSDOM } from "jsdom";
import { dialectOptions, numbering } from "./dialect.js";
import { chapterTitle } from "./chapter-title.js";

const dialect = defineDialect(dialectOptions);
const dom = new JSDOM("");
const document = dom.window.document;
const fragment = (html) => {
  const element = document.createElement("div");
  element.innerHTML = html;
  return element;
};
const plain = (html) => fragment(html).textContent;
// DOM serialization leaves angle brackets literal in quoted attributes. Keep
// authored TeX/quote metadata escaped as well as the visible content.
const serialize = (root) =>
  root.innerHTML.replace(/="[^"]*"/g, (value) =>
    value.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );

// Source ranges come from BananaMark's own editor grammar. UTF-16 offsets are
// converted to Unicode code points before crossing the Python boundary.
export function scan(source) {
  const headings = [],
    numberedMath = [],
    references = new Set();
  let images = false,
    depth = 0;
  dialect.language.language.parser.parse(source).iterate({
    enter(node) {
      const written = source.slice(node.from, node.to);
      if (node.name === "FencedCode") {
        const language = node.node
          .getChild("Document")
          ?.getChild("codeLanguage");
        const body = node.node.getChild("CodeText");
        if (
          language &&
          body &&
          source.slice(language.from, language.to) === "math"
        )
          numberedMath.push(source.slice(body.from, body.to));
      }
      if (node.name === "Image") images = true;
      if (node.name === "Reference")
        references.add(written.replace(/^\{?@-?/, "").replace(/\}$/, ""));
      if (node.name === "EnvironmentFence")
        depth += /^\s*:::\s*$/.test(written) ? -1 : 1;
      if (/^(ATX|Setext)Heading\d$/.test(node.name))
        headings.push({
          line: source.slice(0, node.from).split(/\r\n|\r|\n/).length,
          start: [...source.slice(0, node.from)].length,
          end: [...source.slice(0, node.to)].length,
          root: node.node.parent?.name === "Document" && depth === 0,
        });
    },
  });
  return { headings, references: [...references], images, numberedMath };
}

function annotate(
  html,
  headingData,
  offset,
  chapter,
  prefix,
  labels,
  pageUrl,
  numberedMath,
) {
  const root = fragment(html),
    blocks = [],
    path = [],
    counts = new Map();
  // Peerpedia supplies the shared link/reference controls next to headings.
  root.querySelectorAll(".bm-heading-link").forEach((node) => node.remove());
  // Canonical references keep passage quotes stable when chapter numbers change.
  for (const link of root.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    const label = labels.find(
      (l) =>
        (href === "#" + l.anchor && l.page === chapter) ||
        href === pageUrl(l.page) + "#" + l.anchor,
    );
    if (label) {
      link.dataset.reference = label.name;
      if (link.textContent === label.text)
        link.dataset.passageMath = "@" + label.name;
    }
  }
  // These are presentation, never part of a reader's selected quote.
  const ignored =
    ".bm-heading-link,.bm-section-number,.bm-envtitle,.bm-footnote-backref";
  root.querySelectorAll("br").forEach((node) => {
    if (node.nextSibling?.nodeType === 3)
      node.nextSibling.textContent = node.nextSibling.textContent.replace(
        /^\n/,
        "",
      );
  });
  root.querySelectorAll(".bm-section-number").forEach((node) => {
    if (node.nextSibling?.nodeType === 3) {
      const spaces = node.nextSibling.textContent.match(/^\s*/)[0];
      node.textContent += spaces;
      node.nextSibling.textContent = node.nextSibling.textContent.slice(
        spaces.length,
      );
    }
  });
  root
    .querySelectorAll(ignored)
    .forEach((node) => node.setAttribute("data-passage-ignore", ""));
  root.querySelectorAll(".bm-math-rendered").forEach((node) => {
    const normalize = (tex) =>
      tex
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .join("\n");
    const unnumbered = node.dataset.tex.replace(/\n\\tag\{[\d.]+\}$/, "");
    const canonical = numberedMath.some(
      (tex) => normalize(tex) === normalize(unnumbered),
    )
      ? unnumbered
      : node.dataset.tex;
    const end = node.querySelector(".bm-math-end");
    const punctuation = end
      ? [...end.childNodes]
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent)
          .join("")
      : "";
    node.dataset.passageMath = "$" + canonical + "$" + punctuation;
    node.dataset.passageTex = canonical;
  });
  root.querySelectorAll(".bm-math-display").forEach((node) => {
    if (!node.closest("p,pre,table")) {
      const wrapper = document.createElement("div");
      wrapper.className = "passage-equation";
      node.replaceWith(wrapper);
      wrapper.append(node);
    }
  });
  function text(node) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.hasAttribute("data-passage-ignore"))
      return "";
    if (node.hasAttribute("data-passage-math")) return node.dataset.passageMath;
    if (node.tagName === "BR") return "\n";
    return [...node.childNodes].map(text).join("");
  }
  // Tight lists have no <p>; wrap their leading inline content for selection.
  for (const li of root.querySelectorAll("li")) {
    if (li.closest(".bm-bibliography")) continue;
    const p = document.createElement("p");
    while (
      li.firstChild &&
      !/^(P|UL|OL|DIV|PRE|TABLE|BLOCKQUOTE)$/.test(li.firstChild.nodeName)
    )
      p.append(li.firstChild);
    if (p.childNodes.length) li.prepend(p);
  }
  const candidates = root.querySelectorAll(
    "h1,h2,h3,h4,h5,h6,p,pre,table,.passage-equation",
  );
  for (const node of candidates) {
    if (
      node.closest(".bm-bibliography,.bm-envtitle") ||
      node.parentElement.closest("pre,table,p")
    )
      continue;
    if (/^H[1-6]$/.test(node.tagName)) {
      const level = Number(node.tagName[1]),
        label = text(node).trim();
      while (path.length && path.at(-1).level >= level) path.pop();
      path.push({ level, label });
    }
    let kind =
      node.tagName === "PRE"
        ? "code"
        : node.tagName === "TABLE"
          ? "table"
          : "text";
    const math =
      node.children.length === 1 &&
      node.firstElementChild.matches(".bm-math-display")
        ? node.firstElementChild
        : null;
    let value = text(node);
    if (math) {
      kind = "equation";
      value = math.dataset.passageTex;
    }
    if (!value.trim()) continue;
    const sectionPath = path.map((h) => h.label),
      key = JSON.stringify([sectionPath, kind]);
    const ordinal = counts.get(key) || 0;
    counts.set(key, ordinal + 1);
    const block = {
      id: "b" + (offset + blocks.length),
      kind,
      text: value,
      path: sectionPath,
      ordinal,
      chapter,
    };
    blocks.push(block);
    node.dataset.passage = block.id;
    node.dataset.passageKind = kind;
    node.dataset.passageText = value;
  }
  const elements = [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  const headings = headingData.map((heading, i) => {
    if (heading.line)
      elements[i]?.setAttribute("data-source-line", heading.line);
    return { ...heading, id: prefix + heading.id };
  });
  if (prefix) {
    root.querySelectorAll("[id]").forEach((node) => {
      node.id = prefix + node.id;
    });
    root.querySelectorAll("*").forEach((node) => {
      for (const attribute of [...node.attributes]) {
        let value = attribute.value;
        if (
          ["href", "xlink:href"].includes(attribute.name) &&
          value.startsWith("#")
        )
          value = "#" + prefix + value.slice(1);
        if (node.namespaceURI === "http://www.w3.org/2000/svg")
          value = value.replace(
            /url\(#([^)]*)\)/g,
            (_, id) => `url(#${prefix}${id})`,
          );
        if (value !== attribute.value) node.setAttribute(attribute.name, value);
      }
    });
  }
  return { html: serialize(root), headings, blocks };
}

export async function renderDocument(input) {
  if (input.action === "titles")
    return { titles: input.pages.map((p) => chapterTitle(p.markdown)) };
  if (input.action === "scan") return scan(input.source || "");
  const pages = input.pages || [
    { id: "main", title: "", markdown: input.source || "" },
  ];
  if (
    !pages.length ||
    pages.length > 64 ||
    Buffer.byteLength(JSON.stringify(input)) > 2_000_000
  )
    throw new Error("Document is too large.");
  const reader = input.reader || "",
    prefix = input.prefix || "";
  const url = (key) => reader + "?chapter=" + encodeURIComponent(key);
  const processor = createProcessor({
    dialect,
    checkMath: true,
    resolvePageLink: (key) => ({ url: url(key) }),
  });
  const book = processor.book({ numbering });
  // Metadata-only requests may describe one chapter of a larger book. They must
  // not reject references whose declarations are in the other chapters.
  if (input.action === "structure") {
    const known = new Set(
      pages.flatMap((p) =>
        declaredLabels(p.markdown, { bibliography: true }).map((l) => l.name),
      ),
    );
    for (const name of new Set(
      pages.flatMap((p) => scan(p.markdown).references),
    )) {
      if (!known.has(name) && !pages.some((p) => p.id === name))
        book.declare(name, { text: "@" + name });
    }
  }
  const handles = pages.map((page, i) => {
    let source = page.markdown;
    if (i === pages.length - 1 && input.bibliography?.trim()) {
      const fence = "`".repeat(
        Math.max(
          3,
          ...[...input.bibliography.matchAll(/`+/g)].map(
            (m) => m[0].length + 1,
          ),
        ),
      );
      source +=
        "\n\n## References*\n\n" +
        fence +
        "bibliography\n" +
        input.bibliography +
        "\n" +
        fence +
        "\n";
    }
    return book.add(source, {
      key: page.id,
      title: chapterTitle(page.markdown),
      position: input.numberSections === false ? [] : [i + 1],
      file: page.id + ".md",
    });
  });
  let offset = 0,
    diagramCount = 0;
  const rendered = [],
    entries = {};
  const diagrams = input.diagrams
    ? tikz({
        cache: process.env.BANANAMARK_CACHE || undefined,
        fonts: {
          href: (font) =>
            (input.staticUrl || "/static/") +
            "vendor/bananamark/tikz/" +
            font +
            ".ttf",
        },
        timeout: 8000,
        totalTimeout: 20000,
        workerIdleTimeout: 30000,
      })
    : null;
  try {
    for (const [i, page] of pages.entries()) {
      if (input.renderChapter && input.renderChapter !== page.id) continue;
      const result = book.render(handles[i]);
      if (
        input.diagrams &&
        (!input.diagramChapter || input.diagramChapter === page.id)
      ) {
        const raw = fragment(result.html);
        for (const node of raw.querySelectorAll(".bm-tikz-source")) {
          diagramCount++;
          if (diagramCount > 32)
            throw new Error("Keep each paper below 32 diagrams.");
          if (Buffer.byteLength(node.dataset.tex) > 32768)
            throw new Error("Keep each diagram below 32 KB.");
        }
        result.html = await diagrams.render(result.html, {
          file: page.id + ".md",
        });
      }
      const sourceInfo = scan(page.markdown);
      if (sourceInfo.images)
        throw new Error(
          "Images are not supported. Use a TikZ diagram instead.",
        );
      const headings = result.headings.map((heading, n) => ({
        ...heading,
        ...sourceInfo.headings[n],
        label: plain(heading.title),
        title: n === 0 && heading.level === 1,
      }));
      const resultPage = annotate(
        result.html,
        headings,
        offset,
        page.id,
        prefix,
        book.labels(),
        url,
        sourceInfo.numberedMath,
      );
      offset += resultPage.blocks.length;
      for (const entry of result.bibliography)
        entries[entry.key] = { ...entry, author: entry.citationLabel };
      rendered.push({
        id: page.id,
        title: chapterTitle(page.markdown),
        ...resultPage,
      });
    }
  } finally {
    await diagrams?.close();
  }
  if (input.section) {
    const section = input.section,
      page = rendered.find((p) => p.id === section.chapter);
    const root = fragment(page.html);
    let inside = false;
    for (const node of [...root.childNodes]) {
      const line = Number(node.dataset?.sourceLine || 0);
      if (line === section.line) inside = true;
      if (line >= section.end) inside = false;
      if (!inside) node.remove();
    }
    page.html = serialize(root);
    page.headings = page.headings.filter(
      (h) => h.line >= section.line && h.line < section.end,
    );
  }
  const targets = book.labels().map((label) => ({
    id: prefix + label.anchor,
    label: label.name,
    chapter: label.page,
    kind: label.kind === "bibliography" ? "citation" : label.kind,
    text: label.text,
    title: "",
    line: label.line,
    end_line: label.line,
    explicit: true,
    url:
      url(label.page) +
      (label.anchor ? "#" + encodeURIComponent(prefix + label.anchor) : ""),
  }));
  for (const page of pages) {
    targets.push({
      id: "",
      label: page.id,
      chapter: page.id,
      kind: "chapter",
      text: chapterTitle(page.markdown),
      title: "",
      explicit: false,
      url: url(page.id),
    });
  }
  for (const page of rendered) {
    for (const heading of page.headings) {
      if (
        heading.title ||
        targets.some((t) => t.chapter === page.id && t.id === heading.id)
      )
        continue;
      targets.push({
        id: heading.id,
        label: heading.id,
        chapter: page.id,
        kind: "heading",
        text: heading.label,
        title: "",
        explicit: false,
        line: heading.line,
        end_line: heading.line,
        url: url(page.id) + "#" + encodeURIComponent(heading.id),
      });
    }
  }
  return { pages: rendered, targets, entries, warnings: [] };
}
