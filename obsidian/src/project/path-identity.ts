export function isRelativePath(path: string): boolean {
  return path !== "" && !/^[A-Za-z]:|[\\\u0000-\u001f]/.test(path)
    && path.split("/").every((part: string): boolean => part !== "" && part !== "." && part !== "..");
}

export function pathKey(path: string): string {
  return path.normalize("NFD").toLowerCase();
}

const reserved = new Set([".obsidian", ".git", ".peerpedia", ".peerpedia-obsidian"]);

export function isReservedComponent(name: string): boolean {
  return reserved.has(pathKey(name));
}

export function isManuscriptPath(path: string): boolean {
  return isRelativePath(path) && !path.split("/").some(isReservedComponent);
}

export function vaultPath(root: string, path: string): string {
  return root ? `${root}/${path}` : path;
}
