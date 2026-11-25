import { expect, test } from "vitest";
import { DiagramCache } from "../../packages/peerpedia-renderer/browser/diagram-cache";

test("diagram cache evicts by recency and byte budget, ignores oversized entries, and clears", (): void => {
  const cache = new DiagramCache(12, 2);
  cache.set("a", "aa");
  cache.set("b", "bb");
  expect(cache.get("a")).toBe("aa");
  cache.set("c", "cc");
  expect(cache.get("b")).toBeUndefined();
  cache.set("a", "aaaaa");
  expect(cache.get("c")).toBeUndefined();
  cache.set("huge", "x".repeat(100));
  expect(cache.get("huge")).toBeUndefined();
  expect(cache.get("a")).toBe("aaaaa");
  cache.clear();
  expect(cache.get("a")).toBeUndefined();
});
