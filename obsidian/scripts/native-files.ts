import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

interface NativeToolchain { compiler: string; sdk: string; linker: string; headers: string }
const nativeDirectory = fileURLToPath(new URL("../native", import.meta.url));
const toolchain: NativeToolchain = JSON.parse(readFileSync(join(nativeDirectory, "anchored.json"), "utf8")).toolchain;
export function verifyNativeToolchain(actual: NativeToolchain): void {
  for (const key of ["compiler", "sdk", "linker", "headers"] as const) {
    if (actual[key] !== toolchain[key]) throw new Error(`Native toolchain mismatch: ${key} requires ${toolchain[key]}, got ${actual[key]}. Select Xcode 16.4 (or matching Command Line Tools) and install locked dependencies.`);
  }
}
export function compileNativeFiles(): Buffer {
  if (process.platform !== "darwin") throw new Error("Build the macOS file helper on macOS with Xcode Command Line Tools.");
  const headersPackage = new URL("../node_modules/node-api-headers/", import.meta.url);
  verifyNativeToolchain({
    compiler: execFileSync("/usr/bin/xcrun", ["clang", "--version"], { encoding: "utf8" }).split("\n")[0],
    sdk: execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-version"], { encoding: "utf8" }).trim(),
    linker: JSON.parse(execFileSync("/usr/bin/xcrun", ["ld", "-version_details"], { encoding: "utf8" })).version,
    headers: JSON.parse(readFileSync(new URL("package.json", headersPackage), "utf8")).version,
  });
  const dir = mkdtempSync(join(tmpdir(), "peerpedia-build-"));
  try {
    const out = join(dir, "anchored.node");
    const headers = fileURLToPath(new URL("include/", headersPackage));
    execFileSync("/usr/bin/xcrun", ["clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=11.0", "-bundle", "-undefined", "dynamic_lookup",
      "-I", headers, join(nativeDirectory, "anchored.c"), "-o", out]);
    return readFileSync(out);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
export function nativeFiles(directory: string = nativeDirectory): string {
  const metadata: { source: string; component: string } = JSON.parse(readFileSync(join(directory, "anchored.json"), "utf8"));
  if (digest(readFileSync(join(directory, "anchored.c"))) !== metadata.source) throw new Error("Native source changed; rebuild and verify the component on macOS.");
  const bytes = readFileSync(join(directory, "anchored.node"));
  if (digest(bytes) !== metadata.component) throw new Error("Native component checksum mismatch.");
  return bytes.toString("base64");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bytes = compileNativeFiles();
  if (process.argv[2] === "--write") {
    writeFileSync(join(nativeDirectory, "anchored.node"), bytes);
    writeFileSync(join(nativeDirectory, "anchored.json"), JSON.stringify({
      source: digest(readFileSync(join(nativeDirectory, "anchored.c"))), component: digest(bytes),
      toolchain,
    }, null, 2) + "\n");
  } else if (!bytes.equals(Buffer.from(nativeFiles(), "base64"))) {
    throw new Error("Native rebuild differs from the checked-in component.");
  }
}
