import { sourceDigest, projectRevision } from "../src/project/store";
import type { ProjectSnapshot, SourceFile } from "../src/project/types";

export function makeProject(count: number): ProjectSnapshot {
  const chapters = Array.from(
    { length: count },
    (_: unknown, i: number): { id: string; title: string; file: string } => ({
      id: `ch${i}`,
      title: `Chapter ${i}`,
      file: `ch${i}.md`,
    }),
  );
  const config = {
    title: "Synthetic manuscript",
    authors: "A",
    abstract: "A",
    primary_category: "math",
    secondary_categories: [],
    license: "CC-BY-4.0",
    chapters,
  };
  const source =
    "This paragraph introduces **an important fact** and $x^2 + y^2 = z^2$, with a second formula $\\alpha + \\beta = \\gamma$.\n\n".repeat(
      55,
    );
  const files: SourceFile[] = chapters.map(
    (chapter: { id: string; file: string }, i: number): SourceFile => {
      const text = `# Chapter ${i}\n\n` + source;
      return {
        path: chapter.file,
        text,
        digest: sourceDigest(Buffer.from(text)),
      };
    },
  );
  const text = JSON.stringify(config);
  files.unshift({
    path: "paper.json",
    text,
    digest: sourceDigest(Buffer.from(text)),
  });
  return { root: "synthetic", config, files, revision: projectRevision(files) };
}
export function edit(project: ProjectSnapshot): ProjectSnapshot {
  const files = project.files.map((file: SourceFile, i: number): SourceFile => {
    if (i !== 1) return file;
    const text = file.text + "\nOne new sentence.\n";
    return { ...file, text, digest: sourceDigest(Buffer.from(text)) };
  });
  return { ...project, files, revision: projectRevision(files) };
}
