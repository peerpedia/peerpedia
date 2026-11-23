import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";

import { isMissing, locatePath } from "./paths";
import { sourceDigest } from "./store";
import { ProjectReadError, type SourceFile } from "./types";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function readSource(
  root: string,
  path: string,
  identities: Map<string, string>,
): Promise<SourceFile | undefined> {
  try {
    const disk = await locatePath(root, path, path);
    if (!disk) return undefined;
    if (!disk.stat.isFile()) throw new ProjectReadError(path, `Project path "${path}" must name a regular file.`);
    if (await realpath(disk.absolute) !== disk.absolute) {
      throw new ProjectReadError(path, `Do not use a symlink in project path "${path}".`);
    }
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const handle = await open(disk.absolute, flags);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.dev !== disk.stat.dev || stat.ino !== disk.stat.ino) {
        throw new ProjectReadError(path, `Project file "${path}" changed while opening it. Reload the project.`);
      }
      const key = `${stat.dev}:${stat.ino}`;
      const alias = identities.get(key);
      if (alias !== undefined) {
        throw new ProjectReadError(path, `Paths "${alias}" and "${path}" refer to the same file.`);
      }
      const bytes = await handle.readFile();
      let text: string;
      try {
        text = decoder.decode(bytes);
      } catch {
        throw new ProjectReadError(path, `Project file "${path}" is not valid UTF-8.`);
      }
      identities.set(key, path);
      return { path, text, digest: sourceDigest(bytes) };
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}
