import type { ProjectSnapshot } from "../project/types";
import type { WritingAnalysis } from "./analysis";
import type { CompletionContext, Suggestion } from "./completion";

export interface LanguageInputs {
  title: string;
  analyze: ProjectSnapshot;
  complete: { context: CompletionContext; project?: ProjectSnapshot };
}

export interface LanguageOutputs {
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
