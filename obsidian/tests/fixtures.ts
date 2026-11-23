import { createHash } from "node:crypto";

import type { PaperConfig, ProjectSnapshot, SourceFile } from "../src/project/types";

function fixtureSource(path: string, text: string): SourceFile {
  return { path, text, digest: createHash("sha256").update(text).digest("hex") };
}

function fixtureSnapshot(root: string, config: PaperConfig, files: readonly SourceFile[]): ProjectSnapshot {
  const inputs = files.map((file: SourceFile): readonly [string, string] => [file.path, file.digest]);
  inputs.sort(([left]: readonly [string, string], [right]: readonly [string, string]): number =>
    left < right ? -1 : Number(left > right),
  );
  const revision = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
  return { root, config, files, revision };
}

export function projectFixture(): ProjectSnapshot {
  const config: PaperConfig = {
    title: "A mathematical paper", authors: "Ada Example", abstract: "Worked examples",
    primary_category: "math.GT", secondary_categories: ["math.AT", "math.AG"], license: "CC-BY-4.0",
    chapters: [
      { id: "intro", title: "Introduction", file: "chapters/z-intro.md" },
      { id: "proof", title: "Proof", file: "chapters/a-proof.md" },
    ],
    bibliography: "references.yaml",
  };
  return fixtureSnapshot("paper", config, [
    fixtureSource("paper.json", JSON.stringify(config, null, 2) + "\r\n"),
    fixtureSource("chapters/z-intro.md", "# **Introduction** {@sec:intro}\r\n\r\n正文 😀\r\n"),
    fixtureSource("chapters/a-proof.md", "Proof\n=====\n\n::: theorem {@thm:main}\nA statement [@example].\n:::\n"),
    fixtureSource("references.yaml", "example:\r\n  type: book\r\n  title: An example\r\n  author: Ada Example\r\n  year: 2026\r\n"),
  ]);
}

export function editFixture(base: ProjectSnapshot, path: string, text: string): ProjectSnapshot {
  const file = fixtureSource(path, text);
  const files = base.files.filter((item: SourceFile): boolean => item.path !== path);
  const config: PaperConfig = path === "paper.json" ? JSON.parse(text) : base.config;
  return fixtureSnapshot(base.root, config, [...files, file]);
}
