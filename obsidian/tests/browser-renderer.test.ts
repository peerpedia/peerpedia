import { afterEach, expect, test, vi } from "vitest";
import {
  BrowserRendererClient,
  type RenderWorker,
} from "../src/preview/browser-renderer-client";
import type { RenderRequest, RenderResponse } from "../renderer/protocol";
import { projectFixture } from "./fixtures";
import { toPublicationDocument } from "../src/project/document";

const request: RenderRequest = {
  id: "same",
  revision: "1",
  document: toPublicationDocument(projectFixture()),
};
class ControlledWorker implements RenderWorker {
  onmessage: ((event: MessageEvent<RenderResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  requests: RenderRequest[] = [];
  postMessage(value: RenderRequest): void {
    this.requests.push(value);
  }
  terminate(): void {
    this.terminated = true;
  }
  finish(): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: { ...this.requests.at(-1)!, pages: [] },
      }),
    );
  }
}
function setup(): {
  client: BrowserRendererClient;
  workers: ControlledWorker[];
} {
  const workers: ControlledWorker[] = [];
  const client = new BrowserRendererClient({
    timeoutMs: 1000,
    idleMs: 100,
    createWorker: (): ControlledWorker => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  return { client, workers };
}
afterEach((): void => {
  vi.useRealTimers();
});

test("one consumer cancelling cannot reject another consumer's queued render, including duplicate IDs", async (): Promise<void> => {
  const { client, workers } = setup();
  const a = new AbortController(),
    b = new AbortController();
  const first = client.render(request, a.signal),
    second = client.render(request, b.signal);
  a.abort();
  expect(await first).toHaveProperty("error");
  expect(workers[0].terminated).toBe(true);
  workers[0].finish(); // A late response from a terminated worker must be ignored.
  expect(workers[1].requests).toEqual([request]);
  workers[1].finish();
  expect(await second).toMatchObject({ pages: [] });
  await client.dispose();
});

test("cancelling a queued request leaves the active worker running", async (): Promise<void> => {
  const { client, workers } = setup();
  const first = client.render(request, new AbortController().signal),
    cancel = new AbortController();
  const second = client.render({ ...request, id: "queued" }, cancel.signal);
  cancel.abort();
  expect(await second).toHaveProperty("error");
  expect(workers[0].terminated).toBe(false);
  workers[0].finish();
  expect(await first).toHaveProperty("pages");
  await client.dispose();
});

test("deadlines terminate a stuck worker, the next request recovers, and idle resources are released", async (): Promise<void> => {
  vi.useFakeTimers();
  const { client, workers } = setup();
  expect(workers).toHaveLength(0);
  const stuck = client.render(request, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await stuck).toHaveProperty("error");
  expect(workers[0].terminated).toBe(true);
  const next = client.render(
    { ...request, id: "next" },
    new AbortController().signal,
  );
  workers[1].finish();
  await next;
  await vi.advanceTimersByTimeAsync(100);
  expect(workers[1].terminated).toBe(true);
  await client.dispose();
});

test("unload settles active and queued requests and prevents new workers", async (): Promise<void> => {
  const { client, workers } = setup();
  const first = client.render(request, new AbortController().signal);
  const next = client.render(
    { ...request, id: "next" },
    new AbortController().signal,
  );
  await client.dispose();
  expect(await first).toHaveProperty("error");
  expect(await next).toHaveProperty("error");
  expect(
    await client.render(request, new AbortController().signal),
  ).toHaveProperty("error");
  expect(workers).toHaveLength(1);
  expect(workers[0].terminated).toBe(true);
});

test("a worker error terminates failed work and lets the queued consumer recover", async (): Promise<void> => {
  const { client, workers } = setup();
  const first = client.render(request, new AbortController().signal);
  const next = client.render(
    { ...request, id: "next" },
    new AbortController().signal,
  );
  const event = { preventDefault: vi.fn() } as unknown as ErrorEvent;
  workers[0].onerror!(event);
  expect(await first).toMatchObject({
    error: { message: /could not complete/i },
  });
  expect(workers[0].terminated).toBe(true);
  expect(event.preventDefault).toHaveBeenCalled();
  workers[1].finish();
  expect(await next).toHaveProperty("pages");
  await client.dispose();
});

test("an invalid worker response is rejected and the next request uses a new worker", async (): Promise<void> => {
  const { client, workers } = setup();
  const first = client.render(request, new AbortController().signal);
  workers[0].onmessage!(
    new MessageEvent("message", {
      data: { id: "unexpected", revision: request.revision, pages: [] },
    }),
  );
  expect(await first).toMatchObject({
    error: { message: /invalid response/i },
  });
  expect(workers[0].terminated).toBe(true);
  const next = client.render(request, new AbortController().signal);
  workers[1].finish();
  expect(await next).toHaveProperty("pages");
  await client.dispose();
});
