import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderDocument } from "./render-document.mjs";
import { inspectChapter } from "./chapter-title.js";

test("chapter names come from headings without treating examples as titles", /** @returns {Promise<void>} */ async () => {
  assert.equal(
    inspectChapter("```md\n# Example\n```\n\n# **Actual** title {@ch:title}")
      .title,
    "Actual title",
  );
  assert.equal(
    inspectChapter("A title\n=======\n\nUnfinished $\\badcommand").title,
    "A title",
  );
  assert.equal(inspectChapter("> # Quoted\n\n# Real").title, "Real");
  assert.equal(inspectChapter("No heading").title, "Untitled chapter");
  const result = await renderDocument({
    pages: [
      {
        id: "stable",
        title: "Old metadata",
        markdown:
          "# New title\n\n## A section\n\n### A detail {@sec:detail}\n\nText.",
      },
    ],
    reader: "/submissions/frozen/read/",
  });
  assert.equal(result.pages[0].title, "New title");
  const chapter = result.targets.find((t) => t.kind === "chapter");
  assert.equal(chapter.url, "/submissions/frozen/read/?chapter=stable");
  assert.ok(
    result.targets.some((t) => t.text === "A section" && t.explicit === false),
  );
  assert.ok(result.targets.some((t) => t.label === "sec:detail" && t.explicit));
});

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

test("image scans ignore Markdown examples", /** @returns {Promise<void>} */ async () => {
  assert.deepEqual(
    await renderDocument({
      action: "scan",
      source: "![test](https://example.org/x.png)",
    }),
    { images: true },
  );
  assert.deepEqual(
    await renderDocument({ action: "scan", source: "`![not an image](x)`" }),
    { images: false },
  );
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

test("TikZ compilation and cache use the same blackboard-bold fonts", /** @returns {Promise<void>} */ async () => {
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

test("automatic equation numbers follow chapter order", /** @returns {Promise<void>} */ async () => {
  const a = { id: "a", markdown: "```math {@eq:a}\nx = 1\n```" };
  const b = { id: "b", markdown: "Other chapter." };
  const first = await renderDocument({ pages: [a, b] });
  const second = await renderDocument({ pages: [b, a] });
  assert.match(first.pages[0].html, /tag\{1.1\}/);
  assert.match(second.pages[1].html, /tag\{2.1\}/);
});

test("unsafe author HTML and links are rejected", async () => {
  for (const source of [
    "<script>alert(1)</script>",
    "[bad](javascript:alert(1))",
  ]) {
    await assert.rejects(renderDocument({ source }));
  }
});

test("cache maintenance expires old diagrams and applies the capacity budget", async () => {
  const { mkdtemp, writeFile, utimes, readFile, rm } =
    await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pruneCache } = await import("./cache-maintenance.mjs");
  const cache = await mkdtemp(
    join(process.env.BANANAMARK_CACHE || tmpdir(), "peerpedia-cache-test-"),
  );
  try {
    const old = join(cache, "a".repeat(64) + ".json"),
      recent = join(cache, "b".repeat(64) + ".json");
    await writeFile(old, "old");
    await writeFile(recent, "recent diagram");
    await writeFile(join(cache, "keep.txt"), "not a diagram");
    await utimes(old, new Date(0), new Date(0));
    await utimes(
      recent,
      new Date(Date.now() - 10000),
      new Date(Date.now() - 10000),
    );
    const first = await pruneCache({ cache });
    assert.equal(first.removed, 1);
    assert.equal(first.files, 1);
    const second = await pruneCache({ cache, maxBytes: 1 });
    assert.equal(second.removed, 1);
    assert.equal(second.bytes, 0);
    assert.equal(
      await readFile(join(cache, "keep.txt"), "utf8"),
      "not a diagram",
    );
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
});

/** @returns {Promise<void>} */
async function invalidateReferences() {
  const pages = [
    { id: "first", markdown: "::: theorem {@thm:key}\nA.\n:::" },
    {
      id: "second",
      markdown: "See @thm:key. Cite [@ref].",
    },
  ];
  const input = {
    pages,
    bibliography:
      "ref:\n  type: book\n  title: My Book\n  author: Adams\n  year: 2023",
  };
  const old = await renderDocument(input);
  assert.match(old.pages[1].html, /Theorem 1.1/);
  pages[0].markdown = "::: lemma {@lem:other}\nB.\n:::\n\n" + pages[0].markdown;
  input.bibliography = input.bibliography.replace("2023", "2024");
  const updated = await renderDocument(input);
  assert.match(updated.pages[1].html, /Theorem 1.2/);
  assert.match(updated.pages[1].html, /Adams 2024/);
  pages[0].markdown = "Definition removed.";
  await assert.rejects(renderDocument(input), { code: "label_missing" });
}
test(
  "resolved chapter dependencies follow renumbering, bibliography and removed labels",
  invalidateReferences,
);

/** @returns {Promise<void>} */
async function nativeArticle() {
  const { createBook, createRenderer, defineDialect } =
    await import("bananamark");
  const { dialectOptions, numbering } = await import("./dialect.js");
  const dialect = defineDialect(dialectOptions);
  const book = createBook({ dialect, numbering });
  const source =
    "# Heading\n\n> A *quote* with $x$.\n\n- One\n- Two\n\n`example`.";
  const info = { key: "main", file: "main.md", lang: "en" };
  const handle = book.add(source, {
    key: "main",
    position: [1],
    title: "Heading",
    file: info.file,
  });
  const expected = createRenderer({ dialect }).renderDocument(
    book.transform(handle),
    info,
  );
  const result = await renderDocument({ source });
  assert.equal(result.pages[0].html, expected.html);
  assert.equal(result.pages[0].headings[0].label, "Heading");
}
test("ordinary article HTML is byte-for-byte BananaMark output", nativeArticle);

/** @returns {Promise<void>} */
async function unusedFootnoteMath() {
  await assert.rejects(
    renderDocument({ source: "Text\n\n[^unused]: $\\badCommand$" }),
    { code: "katex", file: "main.md", line: 3 },
  );
}
test(
  "unreferenced footnotes still validate their formulas",
  unusedFootnoteMath,
);

/** @returns {Promise<void>} */
async function discardedCellMath() {
  await assert.rejects(
    renderDocument({
      source: "| a | b |\n|---|---|\n| one | two | $\\unknownMacro$ |",
    }),
    { code: "katex", file: "main.md", line: 3 },
  );
}
test(
  "BananaMark validates hidden overflow table cells on first build",
  discardedCellMath,
);
test("rejected chapter images retain their file and UTF-16 coordinates", /** @returns {Promise<void>} */ async () => {
  await assert.rejects(
    renderDocument({
      pages: [
        { id: "intro", markdown: "# One" },
        { id: "proof", markdown: "# Proof\r\n\r\n😀 ![[figure.png]]" },
      ],
    }),
    { file: "proof.md", line: 3, column: 4 },
  );
});
