export interface ChapterSpec {
  id: string;
  title: string;
  file: string;
}

export interface PaperConfig {
  title: string;
  authors: string;
  abstract: string;
  primary_category: string;
  secondary_categories: string[];
  license: string;
  chapters?: ChapterSpec[];
  bibliography?: string;
}

export interface SourceFile {
  path: string;
  text: string;
  digest: string;
}

export interface ProjectSnapshot {
  root: string;
  revision: string;
  config: PaperConfig;
  files: readonly SourceFile[];
}
