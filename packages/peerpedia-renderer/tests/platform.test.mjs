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
