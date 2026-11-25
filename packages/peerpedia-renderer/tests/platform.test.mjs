import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createDocumentRenderer } from "../core.mjs";

/** @param {string} source @returns {string} */
const hash = (source) => createHash("sha256").update(source).digest("hex");

test("browser core renders a complete document without a process or Buffer global", /** @returns {Promise<void>} */ async () => {
  const render = createDocumentRenderer({ hash });
  const previous = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const result = await render({
      source: "# Title\n\nHello $x^2$.",
      diagrams: false,
    });
    assert.match(result.pages[0].html, /katex/);
    assert.match(result.pages[0].html, /Hello/);
  } finally {
    globalThis.Buffer = previous;
  }
});

test("platform-specific rendering cannot reuse another platform’s cached chapter", /** @returns {Promise<void>} */ async () => {
  /** @param {string} marker @returns {ReturnType<typeof createDocumentRenderer>} */
  const renderer = (marker) =>
    createDocumentRenderer({
      hash,
      createDiagrams: /** @returns {object} */ () => ({
        /** @param {string} html @returns {Promise<string>} */
        render: async (html) => html.replaceAll("bm-tikz-source", marker),
        /** @returns {Promise<void>} */
        close: /** @returns {Promise<void>} */ async () => {},
      }),
    });
  const input = {
    source:
      "```tikz\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n```",
    diagrams: true,
  };
  assert.match(
    (await renderer("first-adapter")(input)).pages[0].html,
    /first-adapter/,
  );
  assert.match(
    (await renderer("second-adapter")(input)).pages[0].html,
    /second-adapter/,
  );
});

test("requesting diagrams without a compiler fails explicitly", /** @returns {Promise<void>} */ async () => {
  await assert.rejects(
    createDocumentRenderer({ hash })({ source: "Text", diagrams: true }),
    /diagram compiler/i,
  );
});

test("rich heading labels retain text and decoded HTML entities", /** @returns {Promise<void>} */ async () => {
  const result = await createDocumentRenderer({ hash })({
    source: "# **Bold** &amp; `code` 中文\n\nBody.",
  });
  assert.equal(result.pages[0].headings[0].label, "Bold & code 中文");
});

test("embedded examples prefix fragment and SVG references without changing namespaces or external links", /** @returns {Promise<void>} */ async () => {
  const render = createDocumentRenderer({
    hash,
    createDiagrams: /** @returns {object} */ () => ({
      render: /** @returns {Promise<string>} */ async () =>
        '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="clip"><path d="M0 0"></path></clipPath></defs><use xlink:href="#clip" clip-path="url(#clip)"></use><text>α &amp; β</text></svg><a id="jump" href="#clip">Go</a><a href="https://example.test/#clip">External</a>',
      close: /** @returns {Promise<void>} */ async () => {},
    }),
  });
  const result = await render({
    source:
      "```tikz\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}\n```",
    diagrams: true,
    prefix: "help-",
  });
  assert.equal(
    result.pages[0].html,
    '<svg xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="help-clip"><path d="M0 0"></path></clipPath></defs><use xlink:href="#help-clip" clip-path="url(#help-clip)"></use><text>α &amp; β</text></svg><a id="help-jump" href="#help-clip">Go</a><a href="https://example.test/#clip">External</a>',
  );
});
