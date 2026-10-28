import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderDocument, scan } from "./render-document.mjs";

test("native book numbering, bibliography and version links", async () => {
  const result = await renderDocument({
    reader: "/snapshot/v1/read/",
    pages: [
      {
        id: "a",
        title: "First",
        markdown:
          "## Intro\n\n::: theorem [Main] {@thm:a}\nA.\n:::\n\n::: lemma {@lem:a}\nB.\n:::\n\n```math {@eq:a}\nx=1\n```\n\n$$z=2$$",
      },
      {
        id: "b",
        title: "Second",
        markdown: "::: theorem {@thm:b}\nSee @thm:a, @eq:a and [@book].\n:::",
      },
    ],
    bibliography:
      "book:\n  type: book\n  title: A Book\n  author: Author, A\n  year: 2020",
  });
  assert.deepEqual(
    result.targets.filter((t) => t.kind === "environment").map((t) => t.text),
    ["Theorem 1.1", "Lemma 1.2", "Theorem 2.1"],
  );
  assert.match(result.pages[1].html, /\/snapshot\/v1\/read\/\?chapter=a#thm:a/);
  assert.match(result.pages[1].html, /Author 2020/);
  assert.match(result.pages[1].html, /bm-bibliography/);
});

test("passage atoms and source ranges agree with native rendering", async () => {
  const source =
    "# Title\n\n🌱 $x$.\n\n## Section\n\nLine.  \nNext.\n\n$$y=2$$\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nx()\n```";
  const {
    pages: [page],
  } = await renderDocument({ source, numberSections: false });
  assert.deepEqual(
    page.blocks.slice(-3).map((b) => b.kind),
    ["equation", "table", "code"],
  );
  assert.equal(page.blocks[1].text, "🌱 $x$.");
  assert.equal(page.blocks[2].text, "Section");
  assert.equal(page.blocks[3].text, "Line.\nNext.");
  assert.equal(
    [...source].slice(page.headings[1].start).join("").slice(0, 10),
    "## Section",
  );
  assert.match(page.html, /data-passage-math="\$x\$\."/);
  assert.equal(scan("![test](https://example.org/x.png)").images, true);
  assert.equal(scan("`![not an image](x)`").images, false);
});

test("validation rejects broken labels and formulas with source locations", async () => {
  for (const [source, code] of [
    ["See @missing.", "label_missing"],
    ["::: theorem {@t}\nA\n:::\n\n::: lemma {@t}\nB\n:::", "label_duplicate"],
    ["Text.\n\n$\\notacommand$", "katex"],
  ])
    await assert.rejects(
      renderDocument({ source }),
      (e) => e.code === code && e.line > 0,
    );
});

test("TikZ compilation and cache use the same blackboard-bold fonts", async () => {
  const input = {
    prefix: "example-",
    source:
      "$$\\begin{tikzcd}\\mathbb{Z}\\arrow[r] & \\mathbb{R}\\end{tikzcd}$$",
    diagrams: true,
  };
  const first = await renderDocument(input);
  const second = await renderDocument(input);
  assert.equal(first.pages[0].html, second.pages[0].html);
  assert.match(first.pages[0].html, /<svg/);
  assert.match(first.pages[0].html, /tikzjax-msbm10/);
  assert.equal(first.pages[0].blocks[0].kind, "equation");
  assert.doesNotMatch(first.pages[0].html, /bm-tikz-source/);
  const document = new JSDOM(first.pages[0].html).window.document;
  for (const node of document.querySelectorAll("svg *")) {
    for (const attr of [...node.attributes]) {
      const id =
        ["href", "xlink:href"].includes(attr.name) && attr.value.startsWith("#")
          ? attr.value.slice(1)
          : attr.value.match(/^url\(#(.+)\)$/)?.[1];
      if (id)
        assert.ok(document.getElementById(id), `Missing SVG target ${id}`);
    }
  }
});

test("automatic equation numbers do not change discussion anchors", async () => {
  const a = { id: "a", markdown: "```math {@eq:a}\nx = 1\n```" };
  const b = { id: "b", markdown: "Other chapter." };
  const first = await renderDocument({ pages: [a, b] });
  const second = await renderDocument({ pages: [b, a] });
  assert.equal(first.pages[0].blocks[0].text, "x = 1");
  assert.equal(second.pages[1].blocks[0].text, "x = 1");
  assert.match(first.pages[0].html, /tag\{1.1\}/);
  assert.match(second.pages[1].html, /tag\{2.1\}/);
});

test("section preview keeps full-book numbering and only selected content", async () => {
  const {
    pages: [page],
  } = await renderDocument({
    source: "## First\n\nFirst.\n\n## Second\n\nSecond.\n\n## Third\n\nThird.",
    section: { chapter: "main", line: 5, end: 9 },
  });
  assert.match(page.html, /Second/);
  assert.doesNotMatch(page.html, /First|Third/);
  assert.equal(page.headings[0].number, "1.2");
});

test("unsafe author HTML and links are rejected", async () => {
  for (const source of [
    "<script>alert(1)</script>",
    "[bad](javascript:alert(1))",
  ]) {
    await assert.rejects(renderDocument({ source }));
  }
});
