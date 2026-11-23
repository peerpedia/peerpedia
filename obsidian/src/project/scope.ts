import { isRelativePath } from "./paths";

export function resolveScope(
  path: string,
  folders: Readonly<Record<string, boolean>>,
  files: Readonly<Record<string, boolean>>,
): boolean {
  path = path.normalize();
  if (!isRelativePath(path)) return false;
  if (Object.hasOwn(files, path)) return files[path];
  let parent = path;
  while (parent) {
    parent = parent.slice(0, Math.max(parent.lastIndexOf("/"), 0));
    if (Object.hasOwn(folders, parent)) return folders[parent];
  }
  return false;
}
