import { createHash } from "node:crypto";

import { isRelativePath, pathKey } from "./paths";
import { ProjectReadError, type ChapterSpec, type PaperConfig, type ProjectSnapshot, type SourceFile } from "./types";

export const CONFIG_PATH = "paper.json";
const CONFIG_KEYS = new Set([
  "title", "authors", "abstract", "primary_category", "secondary_categories",
  "license", "chapters", "bibliography",
]);
const CHAPTER_KEYS = new Set(["id", "title", "file"]);

export interface FileChange {
  path: string;
  beforeDigest: string | null;
  afterText: string | null;
}

export interface ProjectEvent {
  kind: "changed" | "conflict" | "missing";
  paths: readonly string[];
}

export interface ProjectStore {
  read(root: string): Promise<ProjectSnapshot>;
  create(root: string, changes: readonly FileChange[]): Promise<ProjectSnapshot>;
  apply(root: string, expectedRevision: string, changes: readonly FileChange[]): Promise<ProjectSnapshot>;
  /** Report the initial disk state and subsequent changes with project-relative paths. */
  watch(root: string, listener: (event: ProjectEvent) => void): () => void;
}

function configObject(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProjectReadError(CONFIG_PATH, `${label} must be a JSON object.`);
  }
  const fields = value as Record<string, unknown>;
  const unknownKeys = Object.keys(fields).filter((key: string): boolean => !keys.has(key));
  if (unknownKeys.length) {
    throw new ProjectReadError(CONFIG_PATH, `Incompatible ${label}: unknown fields ${unknownKeys.join(", ")}.`);
  }
  return fields;
}

function textField(fields: Record<string, unknown>, key: string, fallback?: string): string {
  const value = fields[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new ProjectReadError(CONFIG_PATH, `"${key}" must be text in paper.json.`);
  return value;
}

function parseChapters(value: unknown): ChapterSpec[] {
  if (!Array.isArray(value)) throw new ProjectReadError(CONFIG_PATH, '"chapters" must be an ordered list.');
  return value.map((item: unknown, index: number): ChapterSpec => {
    const chapter = configObject(item, CHAPTER_KEYS, `chapter ${index + 1} in paper.json`);
    return { id: textField(chapter, "id"), title: textField(chapter, "title"), file: textField(chapter, "file") };
  });
}

export function parsePaperConfig(text: string): PaperConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProjectReadError(CONFIG_PATH, `Invalid JSON in paper.json: ${detail}`);
  }
  const fields = configObject(value, CONFIG_KEYS, CONFIG_PATH);
  const categories = fields.secondary_categories === undefined ? [] : fields.secondary_categories;
  if (!Array.isArray(categories) || !categories.every((category: unknown): category is string => typeof category === "string")) {
    throw new ProjectReadError(CONFIG_PATH, '"secondary_categories" must be a list of text values.');
  }
  const config: PaperConfig = {
    title: textField(fields, "title"),
    authors: textField(fields, "authors"),
    abstract: textField(fields, "abstract"),
    primary_category: textField(fields, "primary_category", ""),
    secondary_categories: categories,
    license: textField(fields, "license", ""),
  };
  if (fields.chapters !== undefined) config.chapters = parseChapters(fields.chapters);
  if (fields.bibliography !== undefined) config.bibliography = textField(fields, "bibliography");
  return config;
}

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
    if (!isRelativePath(path)) throw new ProjectReadError(CONFIG_PATH, `Unsafe project path "${path}".`);
    const key = pathKey(path);
    const previous = paths.get(key);
    if (previous !== undefined) {
      throw new ProjectReadError(CONFIG_PATH, `Paths "${previous}" and "${path}" refer to the same file or have a case or Unicode conflict.`);
    }
    paths.set(key, path);
  }
  return members;
}

export function sourceDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function projectRevision(files: readonly SourceFile[]): string {
  const pairs = files.map((file: SourceFile): readonly [string, string] => [file.path, file.digest]);
  pairs.sort(([left]: readonly [string, string], [right]: readonly [string, string]): number =>
    left < right ? -1 : Number(left > right),
  );
  return createHash("sha256").update(JSON.stringify(pairs)).digest("hex");
}
