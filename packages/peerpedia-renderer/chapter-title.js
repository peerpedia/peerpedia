import { defineDialect } from "bananamark";
import { dialectOptions } from "./dialect.js";

const dialect = defineDialect(dialectOptions);

/** Locate an image using the publication grammar. Its Image node stops before a wiki embed's second bracket.
 * @param {string} source @param {import("@lezer/common").SyntaxNodeRef} node
 * @returns {{from:number,to:number}|undefined} */
export function publicationImage(source, node) {
  if (node.name !== "Image") return undefined;
  const to =
    source.startsWith("![[", node.from) && source[node.to] === "]"
      ? node.to + 1
      : node.to;
  return { from: node.from, to };
}

// Parse the book title and image policy with BananaMark’s own grammar.
/** @param {string} source @returns {{ title: string, images: boolean, imageOffset: number }} */
export function inspectChapter(source) {
  const tree = dialect.language.language.parser.parse(source);
  let imageOffset = -1;
  const headings = [];
  let depth = 0;
  tree.iterate({
    /** @param {import("@lezer/common").SyntaxNodeRef} node @returns {void} */
    enter(node) {
      if (imageOffset < 0)
        imageOffset = publicationImage(source, node)?.from ?? -1;
      if (node.name === "EnvironmentFence")
        depth += /^\s*:::\s*$/.test(source.slice(node.from, node.to)) ? -1 : 1;
      if (
        /^(ATX|Setext)Heading\d$/.test(node.name) &&
        node.node.parent?.name === "Document" &&
        !node.node.parent.parent &&
        depth === 0
      )
        headings.push(node.node);
    },
  });
  let heading = headings[0];
  for (const candidate of headings) {
    if (/Heading1$/.test(candidate.name)) {
      heading = candidate;
      break;
    }
  }
  const title = heading ? headingText(source, heading).slice(0, 250) : "";
  return {
    title: title || "Untitled chapter",
    images: imageOffset >= 0,
    imageOffset,
  };
}

/** @param {string} source @param {import("@lezer/common").SyntaxNode} heading @returns {string} */
function headingText(source, heading) {
  const removed = [];
  heading.toTree().iterate({
    /** @param {import("@lezer/common").SyntaxNodeRef} node @returns {false|void} */
    enter(node) {
      if (
        /^(HeaderMark|EmphasisMark|CodeMark|LinkMark|URL|LinkTitle|Reference|MathMark)$/.test(
          node.name,
        )
      ) {
        removed.push([heading.from + node.from, heading.from + node.to]);
        return false;
      }
    },
  });
  let title = "",
    at = heading.from;
  for (const [from, to] of removed) {
    title += source.slice(at, from);
    at = to;
  }
  title += source.slice(at, heading.to);
  return title.replace(/\s+/g, " ").trim();
}
