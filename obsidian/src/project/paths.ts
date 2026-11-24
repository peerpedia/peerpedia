import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { ProjectReadError } from "./types";

import { isRelativePath, pathKey } from "./path-identity";

export { isManuscriptPath, isReservedComponent, isRelativePath, pathKey } from "./path-identity";

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

interface DiskPath {
  absolute: string;
  stat: BigIntStats;
}

export async function locatePath(base: string, path: string, issuePath: string): Promise<DiskPath | undefined> {
  if (!isRelativePath(path)) {
    throw new ProjectReadError(issuePath, `Unsafe project path "${path}". Use a relative path within the project.`);
  }

  const parts = path.split("/");
  let absolute = base;
  try {
    for (const [index, part] of parts.entries()) {
      const names = await readdir(absolute);
      const aliases = names.filter((name: string): boolean => pathKey(name) === pathKey(part));
      const name = aliases[0];
      if (name === undefined) return undefined;
      if (aliases.length > 1 || name.normalize("NFD") !== part.normalize("NFD")) {
        throw new ProjectReadError(issuePath, `Path "${path}" conflicts with disk spelling or capitalization "${aliases.join('", "')}". Check the file name's case.`);
      }
      absolute = join(absolute, name);
      const stat = await lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw new ProjectReadError(issuePath, `Do not use a symlink in project path "${path}".`);
      if (index === parts.length - 1) return { absolute, stat };
      if (!stat.isDirectory()) throw new ProjectReadError(issuePath, `A parent of "${path}" is not a directory.`);
    }
  } catch (error: unknown) {
    if (!isMissing(error)) throw error;
  }
  return undefined;
}
