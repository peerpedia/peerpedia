import {
  closeSync, constants, fstatSync, fsync, mkdtempSync, openSync, readFile, readFileSync,
  rmSync, writeFile, writeFileSync, type BigIntStats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isMissing, isRelativePath, pathKey } from "./paths";
import { sourceDigest } from "./store";
import type { SourceFile } from "./types";

declare const __PEERPEDIA_ANCHORED__: string;
interface Native {
  open(dir: number, name: string, flags: number, mode: number): number;
  mkdir(dir: number, name: string): void;
  rmdir(dir: number, name: string): void;
  rename(from: number, name: string, to: number, target: string, flag: number): void;
  announce(fd: number): void;
  list(dir: number): string[];
}
let bindings: Native | undefined;
function native(): Native {
  if (bindings) return bindings;
  if (process.platform !== "darwin" || !__PEERPEDIA_ANCHORED__) throw new Error("本机不支持安全项目写入。");
  const bytes = Buffer.from(__PEERPEDIA_ANCHORED__, "base64");
  const key = Symbol.for("peerpedia.anchored-files." + sourceDigest(bytes));
  const cache = globalThis as typeof globalThis & Record<symbol, Native | undefined>;
  if (cache[key]) return bindings = cache[key];
  const dir = mkdtempSync(join(tmpdir(), "peerpedia-native-"));
  try {
    const lib = join(dir, "anchored.node");
    writeFileSync(lib, bytes, { flag: "wx", mode: 0o500 });
    if (!readFileSync(lib).equals(bytes)) throw new Error("无法校验本地文件组件。");
    bindings = createRequire(lib)(lib) as Native;
    cache[key] = bindings;
    return bindings;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const read = promisify(readFile), write = promisify(writeFile), sync = promisify(fsync);
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
interface Pin { fd: number; identity: BigIntStats; parent?: Pin; name: string }

function same(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }

export class AnchoredFiles {
  private closed = false;
  private pendingDirectorySyncs = 0;
  private readonly missing = new Set<string>();
  private readonly pins = new Map<string, Pin>();
  private constructor(readonly base: string, fd: number) {
    this.pins.set("", { fd, identity: fstatSync(fd, { bigint: true }), name: "" });
  }

  static open(base: string): AnchoredFiles {
    const absolute = resolve(base);
    // O_NOFOLLOW_ANY (Darwin) applies to every component of the trusted vault's canonical name.
    const fd = openSync(absolute, directoryFlags | 0x20000000);
    return new AnchoredFiles(absolute, fd);
  }

  private verify(pin: Pin): void {
    if (pin.parent) this.verify(pin.parent);
    const fd = pin.parent ? native().open(pin.parent.fd, pin.name, directoryFlags, 0) :
      openSync(this.base, directoryFlags | 0x20000000);
    try {
      if (!same(pin.identity, fstatSync(fd, { bigint: true }))) throw new Error("文件夹已移动或被替换。");
    } finally { closeSync(fd); }
  }

  private entry(dir: Pin, name: string): string {
    const matches = native().list(dir.fd).filter((item: string): boolean => pathKey(item) === pathKey(name));
    if (matches.length > 1 || (matches[0] && matches[0].normalize("NFD") !== name.normalize("NFD"))) {
      throw new Error(`文件名的大小写或拼写有冲突：${name}`);
    }
    return matches[0] ?? name;
  }

  private pin(path: string, make: boolean = false): Pin {
    if (this.closed) throw new Error("文件操作已结束。");
    if (path === ".") path = "";
    const existing = this.pins.get(path);
    if (existing) { this.verify(existing); return existing; }
    if (!isRelativePath(path)) throw new Error("文件夹路径无效。");
    const parent = this.pin(dirname(path), make);
    const name = this.entry(parent, basename(path));
    let fd: number;
    try {
      fd = native().open(parent.fd, name, directoryFlags, 0);
      if (this.missing.has(path)) { closeSync(fd); throw new Error("写入期间出现了同名文件夹。"); }
    }
    catch (error: unknown) {
      if (!isMissing(error)) throw error;
      this.missing.add(path);
      if (!make) throw error;
      return this.createDirectory(path, parent, name);
    }
    const result: Pin = { fd, parent, name, identity: fstatSync(fd, { bigint: true }) };
    this.pins.set(path, result);
    return result;
  }

  private createDirectory(path: string, parent: Pin, name: string): Pin {
    // The exclusive 0700 staging name belongs to this operation. Only publish the
    // directory after holding its fd; no public-name lookup is allowed to choose the pin.
    const temporary = ".peerpedia-dir-" + randomUUID();
    native().mkdir(parent.fd, temporary);
    const fd = native().open(parent.fd, temporary, directoryFlags, 0);
    let published = false;
    try {
      const identity = fstatSync(fd, { bigint: true });
      this.rename(join(dirname(path), temporary), path, "publish");
      published = true;
      const pin = { fd, parent, name, identity };
      this.verify(pin);
      this.pins.set(path, pin);
      this.missing.delete(path);
      return pin;
    } catch (error: unknown) {
      this.missing.add(path);
      if (!published) {
        try {
          this.verify({fd, parent, name: temporary, identity: fstatSync(fd, {bigint: true})});
          native().rmdir(parent.fd, temporary);
        } catch { /* Leave unknown or nonempty private entries intact. */ }
      }
      closeSync(fd);
      throw error;
    }
  }

  checkRoot(expected: BigIntStats): void {
    if (!same(this.pin("").identity, expected)) throw new Error("原有库文件夹已被替换。");
  }
  directory(path: string): void { this.pin(path); }
  async directories(path: string): Promise<void> {
    if (path === "." || !path) return;
    const parent = dirname(path);
    await this.directories(parent);
    this.pin(path, true);
    await this.sync(parent);
  }
  async mkdir(path: string): Promise<void> {
    const {dir, name} = this.parent(path);
    this.createDirectory(path, dir, name);
    await this.sync(dirname(path));
  }
  sameVolume(...paths: string[]): void {
    const devices = new Set(paths.map((path: string): bigint => this.pin(path).identity.dev));
    if (devices.size !== 1) throw new Error("章节与恢复目录必须位于同一文件系统。");
  }
  list(path: string): string[] { return native().list(this.pin(path).fd); }
  async sync(path: string): Promise<void> {
    const fd = this.pin(path).fd;
    ++this.pendingDirectorySyncs;
    try { await sync(fd); } finally {
      --this.pendingDirectorySyncs;
      if (this.closed && !this.pendingDirectorySyncs) this.releasePins();
    }
  }

  private parent(path: string): { dir: Pin; name: string } {
    if (!isRelativePath(path)) throw new Error("项目路径无效。");
    const dir = this.pin(dirname(path));
    return { dir, name: this.entry(dir, basename(path)) };
  }

  async source(path: string, identities?: Map<string, string>): Promise<SourceFile | undefined> {
    try {
      const { dir, name } = this.parent(path);
      const fd = native().open(dir.fd, name, constants.O_RDONLY, 0);
      try {
        const st = fstatSync(fd, { bigint: true });
        if (!st.isFile()) throw new Error(`需要普通文件：${path}`);
        const key = `${st.dev}:${st.ino}`;
        if (identities?.has(key)) throw new Error(`文件路径重复：${path}`);
        identities?.set(key, path);
        const bytes = await read(fd);
        return { path, text: decoder.decode(bytes), digest: sourceDigest(bytes) };
      } finally { closeSync(fd); }
    } catch (error: unknown) { if (isMissing(error)) return undefined; throw error; }
  }

  mode(path: string): number {
    const { dir, name } = this.parent(path);
    const fd = native().open(dir.fd, name, constants.O_RDONLY, 0);
    try { return fstatSync(fd).mode & 0o777; } finally { closeSync(fd); }
  }

  publicationSignal(stage: string, target: string): () => void {
    const original = this.parent(stage);
    const fd = native().open(original.dir.fd, original.name, constants.O_RDONLY, 0);
    let identity: BigIntStats;
    try { identity = fstatSync(fd, { bigint: true }); } finally { closeSync(fd); }
    return (): void => {
      const current = this.parent(target);
      const live = native().open(current.dir.fd, current.name, constants.O_RDONLY, 0);
      try {
        if (!same(identity, fstatSync(live, { bigint: true }))) throw new Error("发布后文件已改变。");
        native().announce(live);
      } finally { closeSync(live); }
    };
  }

  async file(path: string, text: string, mode: number = 0o600): Promise<void> {
    const { dir, name } = this.parent(path);
    const fd = native().open(dir.fd, name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    try { await write(fd, text); await sync(fd); } finally { closeSync(fd); }
  }

  rename(from: string, to: string, operation: "swap" | "publish"): void {
    const a = this.parent(from), b = this.parent(to);
    this.verify(a.dir); this.verify(b.dir);
    // Both system-call operands are one component relative to the same checked open directories.
    native().rename(a.dir.fd, a.name, b.dir.fd, b.name, operation === "swap" ? 2 : 4);
  }

  releaseRecord(path: string): void {
    // Recovery enumerates entries serially; release leaf pins as each record finishes.
    const pin = this.pins.get(path);
    if (!pin || this.pendingDirectorySyncs || !pin.parent) return;
    if ([...this.pins.values()].some((p: Pin): boolean => p.parent === pin)) return;
    this.pins.delete(path);
    closeSync(pin.fd);
  }

  close(): void {
    this.closed = true;
    if (!this.pendingDirectorySyncs) this.releasePins();
  }

  private releasePins(): void {
    for (const pin of this.pins.values()) closeSync(pin.fd);
    this.pins.clear();
  }
}

export async function withAnchors<T>(base: string, action: (tree: AnchoredFiles) => Promise<T>): Promise<T> {
  const tree = AnchoredFiles.open(base);
  try { return await action(tree); } finally { tree.close(); }
}
