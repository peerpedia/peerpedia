import { readFile, writeFile } from "node:fs/promises";
import { renderDocument } from "../../editor/render-document.mjs";
import { JSDOM } from "../../editor/node_modules/jsdom/lib/api.js";
import { isDeepStrictEqual } from "node:util";
const fixture = JSON.parse(
  await readFile("obsidian/tests/fixtures/render-paper.json", "utf8"),
);
const expected = await renderDocument({
  pages: fixture.chapters,
  bibliography: fixture.bibliography,
  diagrams: true,
  staticUrl: "./",
});
const actual = JSON.parse(
  await readFile(".preview/official-channel/prototype-render.json", "utf8"),
);
if (actual.pages.length !== expected.pages.length)
  throw new Error("Browser and website page counts differ");
/** @param {Node} node @returns {unknown} */
function canonical(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return null;
  return [
    node.namespaceURI,
    node.localName,
    [...node.attributes]
      .map(
        /** @param {Attr} attr @returns {string[]} */ (attr) => [
          attr.name,
          attr.value,
        ],
      )
      .sort(
        /** @param {string[]} a @param {string[]} b @returns {number} */ (
          a,
          b,
        ) => a[0].localeCompare(b[0]),
      ),
    [...node.childNodes]
      .map(canonical)
      .filter(
        /** @param {unknown} item @returns {boolean} */ (item) => item !== null,
      ),
  ];
}
const report = {
  targets: isDeepStrictEqual(actual.targets, expected.targets),
  pages: [],
};
for (let i = 0; i < expected.pages.length; i++) {
  const a = canonical(new JSDOM(actual.pages[i].html).window.document.body),
    b = canonical(new JSDOM(expected.pages[i].html).window.document.body);
  const equal = isDeepStrictEqual(a, b);
  report.pages.push({
    id: expected.pages[i].id,
    domEqual: equal,
    headings: isDeepStrictEqual(
      actual.pages[i].headings,
      expected.pages[i].headings,
    ),
  });
  if (!equal) {
    await writeFile(
      ".preview/official-channel/actual-" + i + ".json",
      JSON.stringify(a, null, 2),
    );
    await writeFile(
      ".preview/official-channel/expected-" + i + ".json",
      JSON.stringify(b, null, 2),
    );
  }
}
await writeFile(
  ".preview/official-channel/equivalence.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
if (
  !report.targets ||
  report.pages.some(
    /** @param {{domEqual:boolean,headings:boolean}} p @returns {boolean} */ (
      p,
    ) => !p.domEqual || !p.headings,
  )
)
  process.exitCode = 1;
