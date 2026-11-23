import { validReferenceName } from "bananamark/internal/scan.mjs";
import type { ProjectAnalysis } from "./analysis";
import type { LabelTarget } from "./index";

export function findTarget(key: string, analysis: ProjectAnalysis): LabelTarget | null {
  const normalized = key.normalize("NFC");
  if (!validReferenceName(normalized)) return null;
  let target: LabelTarget | null = null;
  for (const label of analysis.labels) {
    if (label.key !== normalized) continue;
    if (target) return null;
    target = label;
  }
  return target;
}
