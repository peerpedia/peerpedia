export function isRelativePath(path: string): boolean {
  return path !== "" && !/^[A-Za-z]:|[\\\u0000-\u001f]/.test(path)
    && path.split("/").every((part: string): boolean => part !== "" && part !== "." && part !== "..");
}

export function pathKey(path: string): string {
  return path.normalize("NFD").toLowerCase();
}

export function vaultPath(root: string, path: string): string {
  return root ? `${root}/${path}` : path;
}
