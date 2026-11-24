import { Buffer } from "buffer";
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
  denied as mkdir,
  denied as readdir,
  denied as readFile,
  denied as rename,
  denied as rm,
  denied as stat,
  denied as utimes,
  denied as writeFile,
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
