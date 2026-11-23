import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, expect, test, vi } from "vitest";

import { NodeTransport } from "../src/remote/transport";

const servers: Server[] = [];
async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve: () => void): void => { server.listen(0, "127.0.0.1", resolve); });
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}

afterEach(async (): Promise<void> => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve: () => void): void => { server.close(resolve); });
  }
});

test("sends the requested bytes to the exact authorized origin only and refuses redirects", async (): Promise<void> => {
  let foreign = 0;
  const other = await listen((_req: IncomingMessage, res: ServerResponse): void => { foreign++; res.end(); });
  let visits = 0;
  const origin = await listen((req: IncomingMessage, res: ServerResponse): void => {
    visits++;
    if (req.url === "/api/v1/me/") {
      res.setHeader("X-Field", "value");
      res.end(req.headers.authorization === "Bearer marker" ? "ok" : "missing");
    } else {
      res.writeHead(Number(req.url?.slice(1)), {location: other});
      res.end();
    }
  });
  const transport = new NodeTransport(origin);
  const headers = {Authorization: "Bearer marker"};
  const ok = await transport.request(origin, "/api/v1/me/", "GET", headers, null);
  expect(ok.status).toBe(200);
  expect(ok.headers["x-field"]).toBe("value");
  expect(Buffer.from(ok.body).toString()).toBe("ok");
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    await expect(transport.request(origin, "/" + status, "GET", headers, null)).rejects.toMatchObject({code:"redirect"});
  }
  for (const route of [other, "//" + new URL(other).host, "/\\foreign.invalid/", "/\r\nHost: example"]) {
    await expect(transport.request(origin, route, "GET", headers, null)).rejects.toMatchObject({code:"destination"});
  }
  for (const bad of [other, origin + "/path", "http://example.invalid", origin.replace("//", "//user@")]) {
    await expect(transport.request(bad, "/", "GET", headers, null)).rejects.toMatchObject({code:"destination"});
  }
  await expect(new NodeTransport().request(origin, "/", "GET", headers, null)).rejects.toMatchObject({code:"destination"});
  await expect(transport.request(origin, "/", "GET", {...headers, HOST:"other.invalid"}, null)).rejects.toMatchObject({code:"destination"});
  expect(visits).toBe(9);
  expect(foreign).toBe(0);
});

test("limits both declared and streamed bodies to 12 MiB", async (): Promise<void> => {
  const limit = 12 * 1024 * 1024;
  const origin = await listen((req: IncomingMessage, res: ServerResponse): void => {
    if (req.url === "/declared") {
      res.writeHead(200, {"content-length": limit + 1});
      res.flushHeaders();
    } else {
      res.write(Buffer.alloc(limit));
      res.end(req.url === "/exact" ? "" : "!");
    }
  });
  const transport = new NodeTransport(origin);
  for (const path of ["/declared", "/streamed"]) {
    await expect(transport.request(origin, path, "GET", {}, null)).rejects.toMatchObject({code:"size"});
  }
  expect((await transport.request(origin, "/exact", "GET", {}, null)).body.length).toBe(limit);
});

test("30 second deadline covers a response which has already begun", async (): Promise<void> => {
  let started!: () => void;
  const received = new Promise<void>((resolve: () => void): void => { started = resolve; });
  const origin = await listen((_req: IncomingMessage, res: ServerResponse): void => { res.write("partial"); started(); });
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout"]});
  const response = new NodeTransport(origin).request(origin, "/", "GET", {}, null);
  const assertion = expect(response).rejects.toMatchObject({code:"timeout"});
  await received;
  await vi.advanceTimersByTimeAsync(30_000);
  await assertion;
});
