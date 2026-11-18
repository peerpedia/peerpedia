import { createBook, createRenderer, defineDialect } from "bananamark";
import { declaredLabels } from "bananamark-codemirror";
import { tikz } from "bananamark-tikz";
import { load } from "cheerio";
import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { annotate } from "./passage-html.mjs";
import { dialectOptions, numbering } from "./dialect.js";
import { chapterTitle } from "./chapter-title.js";

const dialect = defineDialect(dialectOptions);
/** @typedef {{id: string, title?: string, markdown: string}} Page */
/** @typedef {{pages?: Page[], source?: string, action?: string, bibliography?: string, reader?: string, prefix?: string,
 * snapshotLinks?: boolean, diagrams?: boolean, staticUrl?: string, renderChapter?: string, diagramChapter?: string, numberSections?: boolean,
 * section?: {chapter:string, line:number, end:number}}} DocumentInput */
/** @typedef {ReturnType<typeof annotate>} AnnotatedChapter */
/** @typedef {ReturnType<typeof createBook>} Book */
/** @typedef {ReturnType<Book["transform"]>} ResolvedDocument */
/** @typedef {ReturnType<typeof createRenderer>} Renderer */
/** @typedef {ReturnType<typeof tikz>} DiagramCompiler */
/** @typedef {import("./passage-html.mjs").Reference} Reference */
/** @typedef {import("./passage-html.mjs").Heading & {title:boolean,number:string}} PageHeading */
/** @typedef {AnnotatedChapter & {headings: PageHeading[], diagramCount:number}} CompiledChapter */
/** @typedef {{id:string, title:string, html:string, snapshot_links?: Array<[number,number,string]>, headings:PageHeading[], blocks:Array<AnnotatedChapter["blocks"][number] & {id:string}>}} RenderedPage */
/** @typedef {{pages:RenderedPage[],targets:object[],entries:Record<string, object>,warnings:string[]}} RenderedDocument */

/** @type {LRUCache<string, CompiledChapter>} */
const chapters = new LRUCache({ max: 256, maxSize: 16 * 1024 * 1024 });

// Source ranges come from BananaMark's own editor grammar. UTF-16 offsets are
// converted to Unicode code points before crossing the Python boundary.
/** @typedef {{line:number,start:number,end:number,root:boolean}} SourceHeading */
/** @param {string} source @returns {{headings:SourceHeading[], references:string[], images:boolean, numberedMath:string[]}} */
export function scan(source) {
  const headings = [],
    numberedMath = [],
    references = new Set();
  let images = false,
    depth = 0;
  let previousFrom = 0,
    line = 1,
    start = 0;
  dialect.language.language.parser.parse(source).iterate({
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
          start,
          end: start + [...source.slice(node.from, node.to)].length,
          root: node.node.parent?.name === "Document" && depth === 0,
        });
      }
    },
  });
  return { headings, references: [...references], images, numberedMath };
}

/** @param {string} html @returns {string} */
function plain(html) {
  return load(html, {}, false).root().text();
}

/** @param {Map<string, Reference|undefined>} previous @param {(href:string)=>Reference|undefined} lookup @returns {boolean} */
function sameLinks(previous, lookup) {
  for (const [href, old] of previous) {
    const current = lookup(href);
    if (old?.name !== current?.name || old?.text !== current?.text)
      return false;
  }
  return true;
}

/** @param {CompiledChapter} compiled @param {number} offset @param {string} id @param {string} title
 * @param {DocumentInput["section"]} section @param {boolean} snapshotLinks @returns {RenderedPage} */
function assemble(compiled, offset, id, title, section, snapshotLinks) {
  const blocks = [];
  for (const [i, block] of compiled.blocks.entries())
    blocks.push({ id: "b" + (offset + i), ...block, path: [...block.path] });

  const chunks = [];
  /** @type {Array<[number,number,string]>} */
  const bindings = [];
  let visible = !section,
    bytes = 0;
  /** @param {string} fragment @returns {void} */
  function append(fragment) {
    chunks.push(fragment);
    if (snapshotLinks) bytes += Buffer.byteLength(fragment);
  }
  for (const [i, marker] of compiled.markers.entries()) {
    if (visible) append(compiled.parts[i]);
    if (marker.kind === "section" && section) {
      if (marker.line === section.line) visible = true;
      if (marker.line >= section.end) visible = false;
    } else if (visible && marker.kind === "passage")
      append(blocks[marker.index].id);
    else if (visible && snapshotLinks && marker.kind === "link")
      bindings.push([bytes, marker.width, marker.href]);
  }
  if (visible) append(compiled.parts.at(-1));
  const headings = [];
  for (const heading of compiled.headings)
    if (
      !section ||
      (heading.line >= section.line && heading.line < section.end)
    )
      headings.push(structuredClone(heading));
  return {
    id,
    title,
    html: chunks.join(""),
    headings,
    blocks,
    ...(snapshotLinks ? { snapshot_links: bindings } : {}),
  };
}

/** @param {Page} page @param {ResolvedDocument} resolved @param {Renderer} renderer
 * @param {DiagramCompiler|null} diagrams @param {number} previousDiagrams @param {string} prefix
 * @param {(href:string)=>Reference|undefined} lookup @returns {Promise<CompiledChapter>} */
async function compileChapter(
  page,
  resolved,
  renderer,
  diagrams,
  previousDiagrams,
  prefix,
  lookup,
) {
  const info = { key: page.id, file: page.id + ".md", lang: "en" };
  const result = renderer.renderDocument(resolved, info);
  let diagramCount = 0;
  if (diagrams && result.html.includes("bm-tikz-source")) {
    const $ = load(result.html, {}, false);
    for (const el of $(".bm-tikz-source")) {
      diagramCount++;
      if (previousDiagrams + diagramCount > 32)
        throw new Error("Keep each paper below 32 diagrams.");
      if (Buffer.byteLength(el.attribs["data-tex"]) > 32768)
        throw new Error("Keep each diagram below 32 KB.");
    }
    result.html = await diagrams.render(result.html, info);
  }
  const source = scan(page.markdown);
  if (source.images)
    throw new Error("Images are not supported. Use a TikZ diagram instead.");
  const headings = [];
  for (const [n, heading] of result.headings.entries()) {
    const { id, level } = heading,
      title = resolved.meta.headingTitles[id];
    headings.push({
      level,
      id: prefix + id,
      number: resolved.meta.sectionNumbers[id] ?? "",
      title: n === 0 && level === 1,
      ...source.headings[n],
      label:
        title === undefined ? "" : plain(renderer.renderFragment(title, info)),
    });
  }
  return {
    ...annotate(
      result.html,
      headings,
      page.id,
      prefix,
      lookup,
      source.numberedMath,
    ),
    headings,
    diagramCount,
  };
}

/** @param {DocumentInput} input @returns {Promise<RenderedDocument|ReturnType<typeof scan>|{titles:string[]}>} */
export async function renderDocument(input) {
  if (input.action === "titles") {
    const titles = [];
    for (const page of input.pages) titles.push(chapterTitle(page.markdown));
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
  const book = createBook({ dialect, checkMath: true, numbering });
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
    titles = [];
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
    const title = chapterTitle(page.markdown);
    titles.push(title);
    handles.push(
      book.add(source, {
        key: page.id,
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
  let labelIndex;
  try {
    for (const [i, page] of pages.entries()) {
      if (input.renderChapter && input.renderChapter !== page.id) continue;
      // Transform resolves all cross-chapter captions, numbering and bibliography
      // before a cache lookup. An invalid chapter cannot reuse a previous success.
      const resolved = book.transform(handles[i]);
      if (!labelIndex) {
        labelIndex = new Map();
        for (const label of book.labels()) {
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
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            page.id,
            page.markdown,
            resolved,
            reader,
            prefix,
            Boolean(compileDiagrams),
            input.staticUrl || "/static/",
          ]),
        )
        .digest("hex");
      let compiled = chapters.get(key);
      if (!compiled || !sameLinks(compiled.links, lookup)) {
        compiled = await compileChapter(
          page,
          resolved,
          renderer,
          compileDiagrams,
          diagramCount,
          prefix,
          lookup,
        );
        let size = Buffer.byteLength(
          JSON.stringify([
            compiled.headings,
            compiled.blocks,
            compiled.markers,
            [...compiled.links],
          ]),
        );
        for (const part of compiled.parts) size += Buffer.byteLength(part);
        chapters.set(key, compiled, { size });
      }
      diagramCount += compiled.diagramCount;
      if (diagramCount > 32)
        throw new Error("Keep each paper below 32 diagrams.");
      rendered.push(
        assemble(
          compiled,
          offset,
          page.id,
          titles[i],
          input.section?.chapter === page.id ? input.section : undefined,
          Boolean(input.snapshotLinks),
        ),
      );
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
