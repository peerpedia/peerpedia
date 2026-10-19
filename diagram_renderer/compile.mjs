// The container is the security boundary. The VM supplies browser APIs to the
// pinned WASM engine; it is not relied on as a sandbox for arbitrary JavaScript.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { parentPort, workerData } from "node:worker_threads";

const base = new URL("../static/vendor/tikzjax/", import.meta.url);
let log = "";
const diagnostic = (...parts) => {
  log = (log + parts.join(" ") + "\n").slice(-8000);
};
const scope = {
  loadDiagramCore: async () => {
    const compressed = await readFile(new URL("core.bin", base));
    const core = gunzipSync(compressed, { maxOutputLength: 163840000 });
    return new Uint8Array(core.buffer, core.byteOffset, core.byteLength);
  },
  fetch: async (name) => {
    if (!["tex.wasm", "core.bin"].includes(name))
      throw new Error("Unexpected compiler asset request");
    return new Response(await readFile(new URL(name, base)));
  },
  Headers,
  Request,
  Response,
  TextEncoder,
  TextDecoder,
  WebAssembly,
  Uint8Array,
  ArrayBuffer,
  setTimeout,
  clearTimeout,
  setImmediate,
  clearImmediate,
  MessageChannel,
  btoa,
  atob,
  performance,
  console: { log: diagnostic, error: diagnostic, warn: diagnostic },
  diagramAssets: { wasm: "tex.wasm", core: "core.bin" },
  postMessage: () => {},
};
scope.self = scope;
try {
  vm.runInNewContext(
    await readFile(new URL("peerpedia-engine.js", base), "utf8"),
    scope,
  );
  const result = await scope.compileDiagram("\\nonstopmode\n" + workerData);
  if (/^!|^l\.\d+|Emergency stop|Fatal error/m.test(log))
    throw new Error("TeX could not compile this diagram. Check its source.");
  parentPort.postMessage({ result });
} catch {
  parentPort.postMessage({
    error: "TeX could not compile this diagram. Check its source.",
  });
}
