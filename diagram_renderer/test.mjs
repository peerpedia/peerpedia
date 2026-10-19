import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import assert from "node:assert/strict";
import test from "node:test";

await test(
  "bounded isolated diagram compiler",
  { timeout: 45000 },
  async (t) => {
    const listener = net.createServer();
    listener.listen(0, "127.0.0.1");
    await once(listener, "listening");
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const server = spawn(
      process.execPath,
      [new URL("./server.mjs", import.meta.url).pathname],
      {
        env: { PATH: process.env.PATH, PORT: String(port) },
        stdio: "ignore",
      },
    );
    t.after(async () => {
      server.kill();
      await once(server, "exit");
    });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(url + "/health")).ok) break;
      } catch {
        /* startup */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const compile = (source) =>
      fetch(url + "/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
    const valid = String.raw`\begin{tikzcd} A \arrow[r] & B \end{tikzcd}`;
    await t.test("compiles the real pinned engine", async () => {
      const response = await compile(valid);
      const data = await response.json();
      assert.ok(data.result.html.includes("<svg"));
      assert.ok(data.result.width > 0);
    });
    await t.test(
      "invalid source and oversized input do not stop the service",
      async () => {
        const response = await compile(
          String.raw`\begin{tikzpicture}\notARealCommand\end{tikzpicture}`,
        );
        assert.ok((await response.json()).error);
        assert.equal((await compile("a".repeat(33000))).status, 400);
        assert.equal((await fetch(url + "/health")).status, 200);
      },
    );
    await t.test(
      "infinite TeX times out, concurrent work is bounded, and next job succeeds",
      async () => {
        const pending = compile(String.raw`\def\forever{\forever}\forever`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal((await compile(valid)).status, 503);
        const data = await (await pending).json();
        assert.match(data.error, /timed out/);
        assert.ok(
          (await (await compile(valid)).json()).result.html.includes("<svg"),
        );
      },
    );
  },
);
