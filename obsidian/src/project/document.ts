import type { PaperConfig } from "./types";

export interface PublicationDocument extends Pick<
  PaperConfig,
  "title" | "authors" | "abstract" | "primary_category" | "secondary_categories" | "license"
> {
  markdown: string;
  chapters: readonly { id: string; title: string; markdown: string }[];
  bibliography: string;
}
