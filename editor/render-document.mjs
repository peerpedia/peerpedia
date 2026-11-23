import { createBook, createRenderer, defineDialect } from "bananamark";
import { tikz } from "bananamark-tikz";
import { load } from "cheerio";
import { decodeHTMLAttribute } from "entities";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { dialectOptions, numbering } from "./dialect.js";
import { inspectChapter } from "./chapter-title.js";

const dialect = defineDialect(dialectOptions);
/** @typedef {{id: string, title?: string, markdown: string}} Page */
/** @typedef {{pages?: Page[], source?: string, action?: string, bibliography?: string, reader?: string, prefix?: string,
 * diagrams?: boolean, staticUrl?: string, numberSections?: boolean}} DocumentInput */
/** @typedef {ReturnType<typeof createBook>} Book */
/** @typedef {ReturnType<Book["transform"]>} ResolvedDocument */
/** @typedef {ReturnType<typeof createRenderer>} Renderer */
/** @typedef {ReturnType<typeof tikz>} DiagramCompiler */
/** @typedef {{id:string,level:number,label:string,title:boolean,number:string}} PageHeading */
/** @typedef {{html:string,headings:PageHeading[],diagramCount:number}} CompiledChapter */
/** @typedef {{id:string,title:string,html:string,headings:PageHeading[]}} RenderedPage */
/** @typedef {{pages:RenderedPage[],targets:object[],entries:Record<string, object>,warnings:string[]}} RenderedDocument */

/** @type {LRUCache<string, CompiledChapter>} */
const chapters = new LRUCache({ max: 256, maxSize: 16 * 1024 * 1024 });

/** @type {LRUCache<string, ReturnType<typeof sourceInfo>>} */
const sources = new LRUCache({ max: 256, maxSize: 4 * 1024 * 1024 });

/** Only fingerprints of source that passed BananaMark's own math checks. */
/** @type {LRUCache<string,boolean>} */
const validated = new LRUCache({ max: 256 });

/** @param {string} source @returns {ReturnType<typeof inspectChapter>} */
function sourceInfo(source) {
  const cached = sources.get(source);
  if (cached) return cached;
  const info = inspectChapter(source);
  sources.set(source, info, {
    size: Math.max(
      1,
      Buffer.byteLength(source) + Buffer.byteLength(info.title),
    ),
  });
  return info;
}

/** @param {string} html @returns {string} */
function plain(html) {
  return load(html, {}, false).root().text();
}

/** Put each embedded help example's fragment links and SVG resources in its own namespace.
 * @param {string} html @param {string} prefix @returns {string} */
function prefixExampleIds(html, prefix) {
  const $ = load(html, {}, false);
  /** @param {string} _match @param {string} id @returns {string} */
  function svgReference(_match, id) {
    return "url(#" + prefix + id + ")";
  }
  for (const element of $("*")) {
    for (const [name, value] of Object.entries(element.attribs)) {
      if (name === "id") element.attribs[name] = prefix + value;
      else if (
        (name === "href" || name === "xlink:href") &&
        value.startsWith("#")
      )
        element.attribs[name] = "#" + prefix + value.slice(1);
      else if (element.namespace === "http://www.w3.org/2000/svg")
        element.attribs[name] = value.replace(/url\(#([^)]*)\)/g, svgReference);
    }
  }
  return $.html();
}

/** @param {Page} page @param {ResolvedDocument} resolved @param {Renderer} renderer
 * @param {DiagramCompiler|null} diagrams @param {number} previousDiagrams @param {string} prefix @returns {Promise<CompiledChapter>} */
async function compileChapter(
  page,
  resolved,
  renderer,
  diagrams,
  previousDiagrams,
  prefix,
) {
  const info = { key: page.id, file: page.id + ".md", lang: "en" };
  const { imageOffset } = sourceInfo(page.markdown);
  if (imageOffset >= 0) {
    const lines = page.markdown.slice(0, imageOffset).split("\n");
    throw Object.assign(new Error("Images are not supported. Use a TikZ diagram instead."), {
      file: info.file, line: lines.length, column: lines.at(-1).length + 1,
    });
  }
  const result = renderer.renderDocument(resolved, info);
  let diagramCount = 0;
  if (diagrams && result.html.includes("bm-tikz-source")) {
    // Inspect only the renderer's diagram placeholders. The library replaces them
    // with SVG; ordinary chapters pass through as a single immutable string.
    for (const match of result.html.matchAll(
      /<span(?: id="[^"]*")? class="bm-math-rendered(?: bm-math-display)? bm-tikz-source" data-tex="([^"]*)"/g,
    )) {
      if (previousDiagrams + ++diagramCount > 32)
        throw new Error("Keep each paper below 32 diagrams.");
      if (
        Buffer.byteLength(match[1]) > 32768 &&
        Buffer.byteLength(decodeHTMLAttribute(match[1])) > 32768
      )
        throw new Error("Keep each diagram below 32 KB.");
    }
    result.html = await diagrams.render(result.html, info);
  }
  const headings = [];
  for (const [n, heading] of result.headings.entries()) {
    const { id, level } = heading,
      title = resolved.meta.headingTitles[id];
    headings.push({
      level,
      id: prefix + id,
      number: resolved.meta.sectionNumbers[id] ?? "",
      title: n === 0 && level === 1,
      // Rich labels are rendered as standalone title fragments. A chapter's HTML
      // is never reopened to recover its table of contents.
      label:
        title === undefined
          ? ""
          : !title.nodes.length && /^[\p{L}\p{N} .,-]+$/u.test(title.markdown)
            ? title.markdown
            : plain(renderer.renderFragment(title, info)),
    });
  }
  return {
    html: prefix ? prefixExampleIds(result.html, prefix) : result.html,
    headings,
    diagramCount,
  };
}

/** @param {DocumentInput} input @returns {Promise<RenderedDocument|{images:boolean}>} */
export async function renderDocument(input) {
  if (input.action === "scan")
    return { images: sourceInfo(input.source || "").images };
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
  /** @param {string} key @returns {string} */
  function url(key) {
    return reader + "?chapter=" + encodeURIComponent(key);
  }
  /** @param {string} key @returns {{url:string}} */
  function resolvePageLink(key) {
    return { url: url(key) };
  }
  const renderer = createRenderer({ dialect, resolvePageLink });
  const book = createBook({ dialect, numbering });
  const handles = [],
    titles = [],
    sourceKeys = [];
  for (const [i, page] of pages.entries()) {
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
    const title = sourceInfo(page.markdown).title;
    titles.push(title);
    const sourceKey = createHash("sha256").update(source).digest("hex");
    sourceKeys.push(sourceKey);
    handles.push(
      book.add(source, {
        key: page.id,
        // Let BananaMark catch errors even in unused source (e.g. a footnote)
        // on the first build. Identical source already passed the same dialect.
        checkMath: !validated.has(sourceKey),
        title,
        position: input.numberSections === false ? [] : [i + 1],
        file: page.id + ".md",
      }),
    );
  }
  let diagramCount = 0;
  const rendered = [],
    entries = {};
  const diagrams = input.diagrams
    ? tikz({
        cache: process.env.BANANAMARK_CACHE || undefined,
        fonts: {
          /** @param {string} font @returns {string} */
          href(font) {
            return (
              (input.staticUrl || "/static/") +
              "vendor/bananamark/tikz/" +
              font +
              ".ttf"
            );
          },
        },
        timeout: 8000,
        totalTimeout: 20000,
        workerIdleTimeout: 30000,
      })
    : null;
  try {
    for (const [i, page] of pages.entries()) {
      // Transform resolves all cross-chapter captions, numbering and bibliography
      // before a cache lookup. An invalid chapter cannot reuse a previous success.
      const resolved = book.transform(handles[i]);
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            page.id,
            page.markdown,
            resolved,
            reader,
            prefix,
            Boolean(diagrams),
            input.staticUrl || "/static/",
          ]),
        )
        .digest("hex");
      let compiled = chapters.get(key);
      if (!compiled) {
        compiled = await compileChapter(
          page,
          resolved,
          renderer,
          diagrams,
          diagramCount,
          prefix,
        );
        const size =
          Buffer.byteLength(compiled.html) +
          Buffer.byteLength(JSON.stringify(compiled.headings));
        chapters.set(key, compiled, { size });
      }
      validated.set(sourceKeys[i], true);
      diagramCount += compiled.diagramCount;
      if (diagramCount > 32)
        throw new Error("Keep each paper below 32 diagrams.");
      rendered.push({
        id: page.id,
        title: titles[i],
        html: compiled.html,
        headings: structuredClone(compiled.headings),
      });
      for (const entry of resolved.meta.bibliography)
        entries[entry.key] = { ...entry, author: entry.citationLabel };
    }
  } finally {
    await diagrams?.close();
  }
  const targets = [];
  const anchors = new Map();
  for (const page of pages) anchors.set(page.id, new Set([""]));
  for (const label of book.labels()) {
    anchors.get(label.page)?.add(prefix + label.anchor);
    targets.push({
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
    });
  }
  for (const [index, page] of pages.entries()) {
    targets.push({
      id: "",
      label: page.id,
      chapter: page.id,
      kind: "chapter",
      text: titles[index],
      title: "",
      explicit: false,
      url: url(page.id),
    });
  }
  for (const page of rendered) {
    for (const heading of page.headings) {
      const ids = anchors.get(page.id);
      if (heading.title || ids.has(heading.id)) continue;
      ids.add(heading.id);
      targets.push({
        id: heading.id,
        label: heading.id,
        chapter: page.id,
        kind: "heading",
        text: heading.label,
        title: "",
        explicit: false,
        url: url(page.id) + "#" + encodeURIComponent(heading.id),
      });
    }
  }
  return { pages: rendered, targets, entries, warnings: [] };
}
