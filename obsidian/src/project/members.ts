import { isManuscriptPath, pathKey } from "./path-identity";
import { ProjectReadError, type PaperConfig } from "./types";

export const CONFIG_PATH = "paper.json";

export function projectMembers(config: PaperConfig): readonly string[] {
  const members = [CONFIG_PATH];
  const paths = new Map([[pathKey(CONFIG_PATH), CONFIG_PATH]]);
  const ids = new Set<string>();
  for (const chapter of config.chapters ?? []) {
    const key = chapter.id.toLowerCase();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(chapter.id) || ids.has(key)) {
      throw new ProjectReadError(CONFIG_PATH, `Invalid or duplicate chapter ID "${chapter.id}".`);
    }
    ids.add(key);
    if (!/\.md$/i.test(chapter.file)) {
      throw new ProjectReadError(CONFIG_PATH, `Chapter path "${chapter.file}" must name a Markdown file.`);
    }
    members.push(chapter.file);
  }
  if (members.length === 1) members.push("paper.md");
  if (config.bibliography) members.push(config.bibliography);
  for (const path of members.slice(1)) {
    if (!isManuscriptPath(path)) throw new ProjectReadError(CONFIG_PATH, `Unsafe project path "${path}".`);
    const key = pathKey(path);
    const previous = paths.get(key);
    if (previous !== undefined) {
      throw new ProjectReadError(CONFIG_PATH, `Paths "${previous}" and "${path}" refer to the same file or have a case or Unicode conflict.`);
    }
    paths.set(key, path);
  }
  return members;
}
