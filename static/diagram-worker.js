/* One disposable worker per compilation. TeX sees only its virtual filesystem. */
const assetURLs = new Set(
  [self.diagramAssets.wasm, self.diagramAssets.core].map(
    (path) => new URL(path, self.location.href).href,
  ),
);
const fetchAsset = self.fetch.bind(self);
self.fetch = (input) => {
  const url = new URL(input, self.location.href).href;
  if (!assetURLs.has(url)) throw new Error("Unexpected diagram asset request");
  return fetchAsset(url, { credentials: "omit", redirect: "error" }).then(
    (response) => {
      if (!response.ok) throw new Error("Could not load the diagram compiler");
      return response;
    },
  );
};
importScripts(self.diagramAssets.engine);
let started = false;
self.onmessage = async ({ data }) => {
  if (started) return;
  started = true;
  let log = "";
  // TeX diagnostics are bounded and returned as plain text, never HTML.
  console.log = console.error = (...parts) => {
    log = (log + parts.join(" ") + "\n").slice(-8000);
  };
  try {
    if (
      typeof data !== "string" ||
      new TextEncoder().encode(data).length > 32768
    )
      throw new Error("Keep each diagram below 32 KB.");
    const result = await self.compileDiagram("\\nonstopmode\n" + data);
    if (/^!|^l\.\d+|Emergency stop|Fatal error/m.test(log))
      throw new Error("TeX could not compile this diagram.");
    if (!result.html || result.html.length > 2000000)
      throw new Error("Diagram output is empty or too large.");
    self.postMessage({ type: "result", result });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: /^!|Emergency stop|Fatal error/m.test(log)
        ? "TeX could not compile this diagram."
        : error.message,
      log,
    });
  }
};
