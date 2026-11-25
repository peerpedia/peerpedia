import { expect, test } from "vitest";
import { gunzipSync } from "node:zlib";
import { portableGzip } from "../../packages/peerpedia-renderer/build-browser";

test("embedded gzip resources round-trip without recording the builder OS", (): void => {
  const source = "Math αβγ and diagram resources";
  const bytes = portableGzip(source);
  expect(bytes[9]).toBe(255);
  expect(gunzipSync(bytes).toString()).toBe(source);
});
