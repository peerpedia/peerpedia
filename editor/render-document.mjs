import { createBook, createRenderer, defineDialect } from "bananamark";
import { declaredLabels } from "bananamark-codemirror";
import { tikz } from "bananamark-tikz";
import { load } from "cheerio";
import { decodeHTMLAttribute } from "entities";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { annotate } from "./passage-html.mjs";
import { dialectOptions, numbering } from "./dialect.js";
import { chapterTitle, headingText } from "./chapter-title.js";

const dialect = defineDialect(dialectOptions);
/** @typedef {{id: string, title?: string, markdown: string}} Page */
/** @typedef {{pages?: Page[], source?: string, action?: string, bibliography?: string, reader?: string, prefix?: string,
 * passageComments?: boolean, diagrams?: boolean, staticUrl?: string, renderChapter?: string, diagramChapter?: string, numberSections?: boolean,
 * section?: {chapter:string, line:number, end:number}}} DocumentInput */
/** @typedef {ReturnType<typeof annotate>["blocks"]} Blocks */
/** @typedef {ReturnType<typeof createBook>} Book */
/** @typedef {ReturnType<Book["transform"]>} ResolvedDocument */
/** @typedef {ReturnType<typeof createRenderer>} Renderer */
/** @typedef {ReturnType<typeof tikz>} DiagramCompiler */
/** @typedef {import("./passage-html.mjs").Reference} Reference */
/** @typedef {import("./passage-html.mjs").Heading & {title:boolean,number:string}} PageHeading */
/** @typedef {{html:string,headings:PageHeading[],blocks:Blocks,diagramCount:number}} CompiledChapter */
/** @typedef {{id:string,title:string,html:string,nativeHtml?:boolean,headings:PageHeading[],blocks:Blocks}} RenderedPage */
/** @typedef {{pages:RenderedPage[],targets:object[],entries:Record<string, object>,warnings:string[]}} RenderedDocument */

/** @type {LRUCache<string, CompiledChapter>} */
const chapters = new LRUCache({ max: 256, maxSize: 16 * 1024 * 1024 });

/** @type {LRUCache<string, ReturnType<typeof sourceInfo>>} */
const sources = new LRUCache({ max: 256, maxSize: 4 * 1024 * 1024 });

/** Only fingerprints of source that passed BananaMark's own math checks. */
/** @type {LRUCache<string,boolean>} */
const validated = new LRUCache({ max: 256 });

// Source ranges come from BananaMark's own editor grammar. UTF-16 offsets are
// converted to Unicode code points before crossing the Python boundary.
/** @typedef {{line:number,start:number,end:number,root:boolean, label:string,level:number}} SourceHeading */
/** @param {string} source @returns {{headings:SourceHeading[], references:string[], images:boolean, numberedMath:string[]}} */
export function scan(source) {
  return structuredClone(sourceInfo(source).scan);
}

/** @param {string} source @returns {{title:string,scan:{headings:SourceHeading[],references:string[],images:boolean,numberedMath:string[]}}} */
function sourceInfo(source) {
  const cached = sources.get(source);
  if (cached) return cached;
  const tree = dialect.language.language.parser.parse(source);
  const headings = [],
    numberedMath = [],
    references = new Set();
  let images = false,
    depth = 0;
  let previousFrom = 0,
    line = 1,
    start = 0;
  tree.iterate({
    /** @param {import("@lezer/common").SyntaxNodeRef} node @returns {void} */
    enter(node) {
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
        references.add(
          source
            .slice(node.from, node.to)
            .replace(/^\{?@-?/, "")
            .replace(/\}$/, ""),
        );
      if (node.name === "EnvironmentFence")
        depth += /^\s*:::\s*$/.test(source.slice(node.from, node.to)) ? -1 : 1;
      if (/^(ATX|Setext)Heading\d$/.test(node.name)) {
        const gap = source.slice(previousFrom, node.from);
        line += gap.split(/\r\n|\r|\n/).length - 1;
        start += [...gap].length;
        previousFrom = node.from;
        headings.push({
          line,
          level: Number(node.name.at(-1)),
          label: headingText(source, node.node),
          start,
          end: start + [...source.slice(node.from, node.to)].length,
          root: node.node.parent?.name === "Document" && depth === 0,
        });
      }
    },
  });
  const info = {
    title: chapterTitle(source, tree),
    scan: { headings, references: [...references], images, numberedMath },
  };
  sources.set(source, info, {
    size: Math.max(
      1,
      Buffer.byteLength(source) + Buffer.byteLength(JSON.stringify(info)),
    ),
  });
  return info;
}

/** @param {string} html @returns {string} */
function plain(html) {
  return load(html, {}, false).root().text();
}

/** Select a section in BananaMark's resolved Markdown, before HTML generation.
 * A root heading ends in a reserved node marker even when the source used Setext syntax.
 * @param {ResolvedDocument} doc @param {SourceHeading[]} headings
 * @param {NonNullable<DocumentInput["section"]>} section @returns {{doc:ResolvedDocument, first:number}} */
function selectSection(doc, headings, section) {
  let first = -1,
    start = doc.markdown.length,
    end = start;
  let n = 0;
  for (const match of doc.markdown.matchAll(/@@node:(\d+):node@@/g)) {
    if (doc.nodes[Number(match[1])]?.type !== "heading") continue;
    const heading = headings[n++];
    if (!heading?.root) continue;
    const from = doc.markdown.lastIndexOf("\n", match.index - 1) + 1;
    if (heading.line === section.line) {
      first = n - 1;
      start = from;
    }
    if (heading.line >= section.end) {
      end = from;
      break;
    }
  }
  let markdown = doc.markdown.slice(start, end);
  // Definitions can live in another section. Let the editor grammar locate
  // their whole source ranges, including multiline URLs and footnotes.
  if (markdown && doc.markdown.includes("]:")) {
    const before = [],
      after = [];
    dialect.language.language.parser.parse(doc.markdown).iterate({
      /** @param {import("@lezer/common").SyntaxNodeRef} node @returns {false|void} */
      enter(node) {
        if (node.name !== "LinkReference" && node.name !== "Footnote") return;
        if (node.to <= start)
          before.push(doc.markdown.slice(node.from, node.to));
        if (node.from >= end)
          after.push(doc.markdown.slice(node.from, node.to));
        return false;
      },
    });
    markdown = [...before, markdown, ...after].join("\n\n");
  }
  return { doc: { ...doc, markdown }, first: Math.max(first, 0) };
}

/** @param {Page} page @param {ResolvedDocument} resolved @param {Renderer} renderer
 * @param {DiagramCompiler|null} diagrams @param {number} previousDiagrams @param {string} prefix
 * @param {((href:string)=>Reference|undefined)|undefined} lookup
 * @param {DocumentInput["section"]} section @param {number} offset @returns {Promise<CompiledChapter>} */
async function compileChapter(
  page,
  resolved,
  renderer,
  diagrams,
  previousDiagrams,
  prefix,
  lookup,
  section,
  offset,
) {
  const info = { key: page.id, file: page.id + ".md", lang: "en" };
  const source = sourceInfo(page.markdown).scan;
  if (source.images)
    throw new Error("Images are not supported. Use a TikZ diagram instead.");
  const selected =
    section && !lookup
      ? selectSection(resolved, source.headings, section)
      : { doc: resolved, first: 0 };
  const result = renderer.renderDocument(selected.doc, info);
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
    const position = source.headings[selected.first + n];
    headings.push({
      ...position,
      level,
      id: prefix + id,
      number: resolved.meta.sectionNumbers[id] ?? "",
      title: selected.first + n === 0 && level === 1,
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
  if (!lookup) return { html: result.html, headings, blocks: [], diagramCount };
  const marked = annotate(
    result.html,
    headings,
    page.id,
    prefix,
    lookup,
    source.numberedMath,
    offset,
    section,
  );
  const visibleHeadings = [];
  for (const heading of headings)
    if (
      !section ||
      (heading.line >= section.line && heading.line < section.end)
    )
      visibleHeadings.push(heading);
  return { ...marked, headings: visibleHeadings, diagramCount };
}

/** @param {DocumentInput} input @returns {Promise<RenderedDocument|ReturnType<typeof scan>|{titles:string[]}>} */
export async function renderDocument(input) {
  if (input.action === "titles") {
    const titles = [];
    for (const page of input.pages)
      titles.push(sourceInfo(page.markdown).title);
    return { titles };
  }
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
  /** @param {string} key @returns {string} */
  function url(key) {
    return reader + "?chapter=" + encodeURIComponent(key);
  }
  /** @param {string} key @returns {{url:string}} */
  function resolvePageLink(key) {
    return { url: url(key) };
  }
  const renderer = createRenderer({ dialect, resolvePageLink });
  const annotations = Boolean(input.passageComments || prefix);
  const book = createBook({ dialect, numbering });
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
  let offset = 0,
    diagramCount = 0;
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
  let labelIndex, referenceKey;
  try {
    for (const [i, page] of pages.entries()) {
      if (input.renderChapter && input.renderChapter !== page.id) continue;
      // Transform resolves all cross-chapter captions, numbering and bibliography
      // before a cache lookup. An invalid chapter cannot reuse a previous success.
      const resolved = book.transform(handles[i]);
      if (annotations && !labelIndex) {
        labelIndex = new Map();
        const labels = book.labels();
        referenceKey = createHash("sha256")
          .update(JSON.stringify(labels))
          .digest("hex");
        for (const label of labels) {
          const address = url(label.page) + "#" + label.anchor;
          if (!labelIndex.has(address))
            labelIndex.set(address, { name: label.name, text: label.text });
        }
      }
      /** @param {string} href @returns {Reference|undefined} */
      function lookup(href) {
        return labelIndex.get(
          href.startsWith("#") ? url(page.id) + href : href,
        );
      }
      const compileDiagrams =
        diagrams && (!input.diagramChapter || input.diagramChapter === page.id)
          ? diagrams
          : null;
      const section =
        input.section?.chapter === page.id ? input.section : undefined;
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            page.id,
            page.markdown,
            resolved,
            annotations,
            section,
            referenceKey,
            offset,
            reader,
            prefix,
            Boolean(compileDiagrams),
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
          compileDiagrams,
          diagramCount,
          prefix,
          annotations ? lookup : undefined,
          section,
          offset,
        );
        const size =
          Buffer.byteLength(compiled.html) +
          Buffer.byteLength(
            JSON.stringify([compiled.headings, compiled.blocks]),
          );
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
        blocks: structuredClone(compiled.blocks),
        ...(annotations ? {} : { nativeHtml: true }),
      });
      offset += compiled.blocks.length;
      for (const entry of resolved.meta.bibliography)
        entries[entry.key] = { ...entry, author: entry.citationLabel };
    }
  } finally {
    await diagrams?.close();
  }
  if (input.section && !rendered.some(hasSectionChapter))
    throw new Error("Section chapter was not rendered.");
  /** @param {RenderedPage} page @returns {boolean} */
  function hasSectionChapter(page) {
    return page.id === input.section?.chapter;
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
        line: heading.line,
        end_line: heading.line,
        url: url(page.id) + "#" + encodeURIComponent(heading.id),
      });
    }
  }
  return { pages: rendered, targets, entries, warnings: [] };
}
