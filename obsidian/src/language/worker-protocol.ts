import type { PublicationDocument } from "../project/publication";
import type { CitationRename, CitationUse } from "../bibliography/rename";
import type { TitlePreview } from "./title-preview";
import type { ProjectSnapshot } from "../project/types";
import type { WritingAnalysis } from "./analysis";
import type { CompletionContext, Suggestion } from "./completion";

export interface LanguageInputs {
  publication: ProjectSnapshot;
  validateCitationKey: { project: ProjectSnapshot; key: string };
  citationImpact: { project: ProjectSnapshot; key: string };
  citationRename: { project: ProjectSnapshot; from: string; to: string };
  previewTitle: {source: string; title: string};
  title: string;
  analyze: ProjectSnapshot;
  complete: { context: CompletionContext; project?: ProjectSnapshot };
}

export interface LanguageOutputs {
  publication: PublicationDocument;
  validateCitationKey: undefined;
  citationImpact: readonly CitationUse[];
  citationRename: CitationRename;
  previewTitle: TitlePreview;
  title: string;
  analyze: WritingAnalysis;
  complete: readonly Suggestion[];
}

export type LanguageKind = keyof LanguageInputs;
export type LanguageRequest = {
  [K in LanguageKind]: { id: number; kind: K; value: LanguageInputs[K] };
}[LanguageKind];

export type LanguageResponse = {
  [K in LanguageKind]: { id: number; kind: K; value: LanguageOutputs[K] };
}[LanguageKind] | { id: number; kind: "error"; message: string };
