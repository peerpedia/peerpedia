import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function nativeFiles(): string {
  if (process.platform !== "darwin") throw new Error("Build the macOS file helper on macOS with Xcode Command Line Tools.");
  const dir = mkdtempSync(join(tmpdir(), "peerpedia-build-"));
  try {
    const out = join(dir, "anchored.node");
    const headers = resolve(dirname(process.execPath), "../include/node");
    execFileSync("/usr/bin/xcrun", ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", "-bundle", "-undefined", "dynamic_lookup",
      "-I", headers, "native/anchored.c", "-o", out]);
    return readFileSync(out).toString("base64");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
