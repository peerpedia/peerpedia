import { afterEach, expect, test } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeFiles } from "../scripts/native-files";

const folders: string[] = [];
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "native-package-test-"));
  folders.push(dir);
  cpSync(new URL("../native", import.meta.url), dir, { recursive: true });
  return dir;
}
afterEach((): void => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("rejects a component whose source changed after compilation", (): void => {
  const dir = fixture();
  writeFileSync(join(dir, "anchored.c"), "changed source");
  expect((): string => nativeFiles(dir)).toThrow(/source/i);
});
test("rejects a corrupted packaged native component", (): void => {
  const dir = fixture();
  writeFileSync(join(dir, "anchored.node"), "not the compiled component");
  expect((): string => nativeFiles(dir)).toThrow(/component/i);
});
test("embeds exactly the verified component", (): void => {
  const dir = fixture();
  expect(Buffer.from(nativeFiles(dir), "base64")).toEqual(readFileSync(join(dir, "anchored.node")));
});
