import assert from "node:assert/strict";
import test from "node:test";
import engine from "node-tikzjax";
import library from "node-tikzjax/dist/library.js";

test("TeX reuses compiled code and memory while isolating jobs and recovering after failure", /** @param {import('node:test').TestContext} t @returns {Promise<void>} */ async (t) => {
  await engine.load();
  const Memory = WebAssembly.Memory;
  const compile = WebAssembly.compile;
  const memories = t.mock.method(
    WebAssembly,
    "Memory",
    /** @param {WebAssembly.MemoryDescriptor} descriptor @returns {WebAssembly.Memory} */ function (
      descriptor,
    ) {
      return new Memory(descriptor);
    },
  );
  const compilations = t.mock.method(
    WebAssembly,
    "compile",
    /** @param {BufferSource} bytes @returns {Promise<WebAssembly.Module>} */ (
      bytes,
    ) => compile(bytes),
  );
  const source = String.raw`\begin{document}\begin{tikzpicture}\draw (0,0) -- (1,1);\node {\ifdefined\previousjob LEAK\else CLEAN\fi\IfFileExists{secret.txt}{LEAK}{CLEAN}};\end{tikzpicture}\end{document}`;
  const first = await engine.tex(source);
  await engine.tex(
    String.raw`\def\previousjob{LEAK}\newwrite\out\immediate\openout\out=secret.txt\immediate\write\out{LEAK}\immediate\closeout\out` +
      source,
  );
  const isolated = await engine.tex(source);
  assert.deepEqual(isolated, first);
  // An execution exception used to bypass library cleanup entirely.
  const cleanup = t.mock.method(library, "deleteEverything");
  const execution = t.mock.method(
    library,
    "executeAsync",
    /** @returns {Promise<never>} */ async () => {
      throw new Error("injected engine failure");
    },
  );
  await assert.rejects(engine.tex(source), /injected engine failure/);
  assert.equal(cleanup.mock.callCount(), 1);
  execution.mock.restore();
  assert.deepEqual(await engine.tex(source), first);
  assert.equal(memories.mock.callCount(), 1);
  assert.equal(compilations.mock.callCount(), 1);
});
