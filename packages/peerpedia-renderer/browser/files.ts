import { Buffer } from "buffer";
import { cacheRequest } from "./diagram-cache";
declare const __RECIPE_FILES__: Record<string, string>;
export function readFileSync(path: URL | string): Buffer {
  const key = String(path).replace("file://", "");
  if (!(key in __RECIPE_FILES__))
    throw new Error("Unexpected source resource: " + key);
  return Buffer.from(__RECIPE_FILES__[key]);
}
export async function denied(..._args: unknown[]): Promise<never> {
  throw new Error("Disk access is unavailable in the browser renderer");
}
export {
  denied as copyFile,
  denied as readdir,
  denied as rename,
  denied as rm,
  denied as stat,
};
export function createRequire(_url: string): {
  resolve: (name: string) => string;
} {
  return {
    resolve(name: string): string {
      if (name !== "node-tikzjax/package.json")
        throw new Error("Unexpected package");
      return "/node-tikzjax/package.json";
    },
  };
}
export function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}
export function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}
export function relative(from: string, to: string): string {
  throw new Error("Unexpected relative path: " + from + " " + to);
}

export const cacheDirectory = "/peerpedia-diagram-cache";
function cacheKey(path: string): string {
  const match = /^\/peerpedia-diagram-cache\/([a-f0-9]{64})\.json$/.exec(path);
  if (!match) throw new Error("Unexpected diagram cache path: " + path);
  return match[1];
}
export async function readFile(
  path: string,
  _encoding: string,
): Promise<string> {
  const value = await cacheRequest("get", cacheKey(path));
  if (value === undefined)
    throw Object.assign(new Error("Diagram cache miss"), { code: "ENOENT" });
  return value;
}
export async function writeFile(path: string, value: string): Promise<void> {
  await cacheRequest("set", cacheKey(path), value);
}
export async function mkdir(path: string, _options: unknown): Promise<void> {
  if (path !== cacheDirectory) await denied();
}
export async function utimes(
  path: string,
  _atime: unknown,
  _mtime: unknown,
): Promise<void> {
  cacheKey(path);
}
