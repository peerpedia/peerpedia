import assert from "node:assert/strict";
import test from "node:test";
import { renderDocument } from "../node.mjs";

/** @param {import("node:test").TestContext} t @returns {Promise<void>} */
async function reuseChapter(t) {
  const katex = (await import("katex")).default;
  const render = t.mock.method(katex, "renderToString");
  const pages = [
    { id: "earlier", markdown: "First." },
    { id: "later", markdown: "A formula $x_{unique}$." },
  ];
  const first = await renderDocument({ pages });
  const coldCalls = render.mock.callCount();
  render.mock.resetCalls();
  pages[0].markdown += "\n\nAdded paragraph.";
  const second = await renderDocument({ pages });
  // Editing another chapter must not recompile the unchanged formula.
  assert.ok(coldCalls > 0);
  assert.ok(render.mock.callCount() < coldCalls);
  assert.equal(first.pages[1].html, second.pages[1].html);
}
test("reuse unaffected chapter HTML in the complete book", reuseChapter);
