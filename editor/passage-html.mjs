// Annotate a parse5 HTML fragment without constructing a browser window or layout objects.
import { load } from "cheerio";
import { randomUUID } from "node:crypto";

/** @typedef {import("domhandler").AnyNode} HtmlNode */
/** @typedef {{name: string, text: string}} Reference */
/** @typedef {{id: string, line?: number, level: number, label: string}} Heading */

/** @param {string} html @returns {string} */
export function escapeAttributes(html) {
  return html.replace(/="[^"]*"/g, escapeAttribute);
}

/** @param {string} value @returns {string} */
function escapeAttribute(value) {
  return value.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** @param {string} tex @returns {string} */
function normalize(tex) {
  const lines = [];
  for (const line of tex.trim().split("\n")) lines.push(line.trim());
  return lines.join("\n");
}

/** @param {HtmlNode} node @returns {string} */
function passageText(node) {
  if (node.type === "text") return node.data;
  if (!("attribs" in node) || "data-passage-ignore" in node.attribs) return "";
  if ("data-passage-math" in node.attribs)
    return node.attribs["data-passage-math"];
  if (node.name === "br") return "\n";
  return node.children.map(passageText).join("");
}

/** @typedef {{kind:"passage", index:number}|{kind:"section", line:number}|{kind:"link", href:string, width:number}} Marker */
/** @param {string} html @param {Heading[]} headings @param {string} chapter
 * @param {string} prefix @param {(href:string)=>Reference|undefined} lookup @param {string[]} numberedMath
 * @returns {{parts: string[], markers: Marker[], blocks: Array<{kind:string,text:string,path:string[],ordinal:number,chapter:string}>, links: Map<string, Reference|undefined>}}
 */
export function annotate(
  html,
  headings,
  chapter,
  prefix,
  lookup,
  numberedMath,
) {
  const $ = load(html, {}, false);
  const links = new Map();
  const slot = randomUUID();
  const relativeLinks = [];
  for (const el of $("a[href]")) {
    const href = el.attribs.href;
    const label = lookup(href);
    links.set(href, label);
    if (href.startsWith("?chapter=")) {
      el.attribs.href = slot + "l" + relativeLinks.length + ";" + href;
      relativeLinks.push(href);
    }
    if (label) {
      el.attribs["data-reference"] = label.name;
      if ($(el).text() === label.text)
        el.attribs["data-passage-math"] = "@" + label.name;
    }
  }
  for (const br of $("br")) {
    if (br.next?.type === "text")
      br.next.data = br.next.data.replace(/^\n/, "");
  }
  for (const el of $(".bm-section-number")) {
    if (el.next?.type === "text") {
      const spaces = el.next.data.match(/^\s*/)[0];
      $(el).text($(el).text() + spaces);
      el.next.data = el.next.data.slice(spaces.length);
    }
  }
  $(
    ".bm-heading-link,.bm-section-number,.bm-envtitle,.bm-footnote-backref",
  ).attr("data-passage-ignore", "");
  const numbered = new Set(numberedMath.map(normalize));
  for (const el of $(".bm-math-rendered")) {
    const tex = el.attribs["data-tex"];
    const bare = tex.replace(/\n\\tag\{[\d.]+\}$/, "");
    const canonical = numbered.has(normalize(bare)) ? bare : tex;
    let punctuation = "";
    for (const child of $(el).find(".bm-math-end").first().contents()) {
      if (child.type === "text") punctuation += child.data;
    }
    el.attribs["data-passage-math"] = "$" + canonical + "$" + punctuation;
    el.attribs["data-passage-tex"] = canonical;
  }
  for (const el of $(".bm-math-display")) {
    if (!$(el).closest("p,pre,table").length)
      $(el).wrap('<div class="passage-equation"></div>');
  }
  for (const li of $("li")) {
    if ($(li).closest(".bm-bibliography").length) continue;
    const p = $("<p></p>");
    while (li.children.length) {
      const child = li.children[0];
      if (
        "name" in child &&
        /^(p|ul|ol|div|pre|table|blockquote)$/.test(child.name)
      )
        break;
      p.append($(child));
    }
    if (p.contents().length) $(li).prepend(p);
  }

  const blocks = [],
    path = [],
    counts = new Map();
  for (const el of $("h1,h2,h3,h4,h5,h6,p,pre,table,.passage-equation")) {
    if (
      $(el).closest(".bm-bibliography,.bm-envtitle").length ||
      $(el).parent().closest("pre,table,p").length
    )
      continue;
    const text = passageText(el);
    if (/^h[1-6]$/.test(el.name)) {
      const level = Number(el.name[1]);
      while (path.length && path.at(-1).level >= level) path.pop();
      path.push({ level, label: text.trim() });
    }
    const children = $(el).children();
    const math = children.length === 1 && children.is(".bm-math-display");
    const kind = math
      ? "equation"
      : el.name === "pre"
        ? "code"
        : el.name === "table"
          ? "table"
          : "text";
    const value = math ? children.attr("data-passage-tex") : text;
    if (!value.trim()) continue;
    const sectionPath = [];
    for (const section of path) sectionPath.push(section.label);
    const key = JSON.stringify([sectionPath, kind]),
      ordinal = counts.get(key) || 0;
    counts.set(key, ordinal + 1);
    blocks.push({ kind, text: value, path: sectionPath, ordinal, chapter });
    el.attribs["data-passage"] = slot + "p" + (blocks.length - 1) + ";";
    el.attribs["data-passage-kind"] = kind;
    el.attribs["data-passage-text"] = value;
  }
  const titles = $("h1,h2,h3,h4,h5,h6");
  for (const [i, heading] of headings.entries()) {
    if (heading.line)
      titles.eq(i).attr("data-source-line", String(heading.line));
  }
  if (prefix) {
    /** @param {string} _match @param {string} id @returns {string} */
    function prefixSvgReference(_match, id) {
      return "url(#" + prefix + id + ")";
    }
    for (const el of $("[id]")) el.attribs.id = prefix + el.attribs.id;
    for (const el of $("*")) {
      for (const [name, original] of Object.entries(el.attribs)) {
        let value = original;
        if (name === "href" && value.startsWith("#"))
          value = "#" + prefix + value.slice(1);
        if (el.namespace === "http://www.w3.org/2000/svg")
          value = value.replace(/url\(#([^)]*)\)/g, prefixSvgReference);
        if (value !== original) el.attribs[name] = value;
      }
    }
  }
  // Record positions while this tree is available. A preview or frozen snapshot
  // can then use the same serialized chapter without parsing it a second time.
  for (const el of $.root().children("[data-source-line]")) {
    const line = Number(el.attribs["data-source-line"]);
    if (Number.isSafeInteger(line) && line > 0)
      $(el).before(slot + "s" + line + ";");
  }
  const serialized = escapeAttributes($.html());
  const parts = [];
  /** @type {Marker[]} */
  const markers = [];
  let cursor = 0;
  for (const match of serialized.matchAll(
    new RegExp(slot + "([pls])([0-9]+);", "g"),
  )) {
    parts.push(serialized.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const index = Number(match[2]);
    if (match[1] === "l") {
      const end = serialized.indexOf('"', cursor);
      markers.push({
        kind: "link",
        href: relativeLinks[index],
        width: Buffer.byteLength(serialized.slice(cursor, end)),
      });
    } else if (match[1] === "s") markers.push({ kind: "section", line: index });
    else markers.push({ kind: "passage", index });
  }
  parts.push(serialized.slice(cursor));
  return { parts, markers, blocks, links };
}
