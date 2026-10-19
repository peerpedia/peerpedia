import http from "node:http";
import { Worker } from "node:worker_threads";

let busy = false;
const reply = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health")
    return reply(res, 200, { ok: true });
  if (req.method !== "POST" || req.url !== "/compile")
    return reply(res, 404, {});
  if (busy) return reply(res, 503, { error: "Compiler busy" });
  // Reserve the slot before reading a body; no unbounded queued requests.
  busy = true;
  let bytes = 0;
  const parts = [];
  const release = () => {
    busy = false;
  };
  req.once("aborted", release);
  req.on("error", release);
  req.on("data", (chunk) => {
    if (res.writableEnded) return;
    bytes += chunk.length;
    if (bytes > 40000) {
      reply(res, 413, {});
      req.destroy();
      release();
    } else parts.push(chunk);
  });
  req.on("end", () => {
    req.removeListener("aborted", release);
    req.removeListener("error", release);
    req.on("error", () => {});
    let source;
    try {
      source = JSON.parse(Buffer.concat(parts).toString("utf8")).source;
    } catch {
      release();
      return reply(res, 400, {});
    }
    if (typeof source !== "string" || Buffer.byteLength(source) > 32768) {
      release();
      return reply(res, 400, {});
    }
    const worker = new Worker(new URL("./compile.mjs", import.meta.url), {
      workerData: source,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let done = false;
    const finish = async (status, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      await worker.terminate();
      release();
      if (!res.destroyed) reply(res, status, data);
    };
    const timer = setTimeout(
      () =>
        finish(200, {
          error: "Diagram compilation timed out. Simplify its source.",
        }),
      15000,
    );
    worker.once("message", (data) => {
      if (JSON.stringify(data).length > 2100000)
        return finish(200, { error: "Diagram output is too large." });
      finish(200, data);
    });
    worker.once("error", () =>
      finish(200, { error: "Diagram compiler exceeded its limits." }),
    );
    worker.once("exit", () => {
      if (!done) finish(200, { error: "Diagram compiler stopped." });
    });
    res.once("close", () => {
      if (!done) finish(499, {});
    });
  });
});
server.requestTimeout = 20000;
server.headersTimeout = 10000;
server.maxConnections = 8;
server.listen(Number(process.env.PORT || 8765), "0.0.0.0");
