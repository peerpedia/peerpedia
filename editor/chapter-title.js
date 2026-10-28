import { defineDialect } from "bananamark";
import { dialectOptions } from "./dialect.js";

const dialect = defineDialect(dialectOptions);

// Use the same grammar as the editor. Fenced examples and nested headings are
// not chapter names, and incomplete equations must not prevent a draft save.
export function chapterTitle(source) {
  const tree = dialect.language.language.parser.parse(source);
  const headings = [];
  let depth = 0;
  tree.iterate({
    enter(node) {
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
  const heading = headings.find((n) => /Heading1$/.test(n.name)) || headings[0];
  if (!heading) return "Untitled chapter";
  const removed = [];
  heading.toTree().iterate({
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
  return title.replace(/\s+/g, " ").trim().slice(0, 250) || "Untitled chapter";
}
