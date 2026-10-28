import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { renderDocument } from "./render-document.mjs";
import { pruneCache } from "./cache-maintenance.mjs";

async function handle(input) {
  try {
    return { result: await renderDocument(input) };
  } catch (error) {
    return {
      error: {
        message: error.message,
        code: error.code,
        file: error.file,
        line: error.line,
        column: error.column,
      },
    };
  }
}
if (process.argv.includes("--stdio")) {
  for await (const line of createInterface({ input: process.stdin })) {
    let response;
    try {
      response = await handle(JSON.parse(line));
    } catch {
      response = { error: { message: "Invalid renderer request." } };
    }
    process.stdout.write(JSON.stringify(response) + "\n");
  }
  process.exit(0);
} else {
  let active = 0,
    maintaining = false,
    nextMaintenance = 0;
  setInterval(async () => {
    if (active || maintaining || Date.now() < nextMaintenance) return;
    maintaining = true;
    try {
      console.log(
        JSON.stringify({ event: "tikz_cache", ...(await pruneCache()) }),
      );
      nextMaintenance = Date.now() + 3600 * 1000;
    } catch (error) {
      console.error(
        JSON.stringify({ event: "tikz_cache_error", message: error.message }),
      );
      nextMaintenance = Date.now() + 60 * 1000;
    } finally {
      maintaining = false;
    }
  }, 60 * 1000).unref();
  createServer(async (req, res) => {
    if (req.url === "/health") {
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/render") {
      res.writeHead(404).end();
      return;
    }
    if (active >= 8 || maintaining) {
      res.writeHead(503).end();
      return;
    }
    active++;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8_000_000) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const result = await handle(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
    } catch {
      res.writeHead(400).end();
    } finally {
      active--;
    }
  }).listen(Number(process.env.PORT || 8765), "0.0.0.0");
}
