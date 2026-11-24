import { createHash } from "node:crypto";
import { tikz } from "bananamark-tikz";
import { createDocumentRenderer } from "./core.mjs";
export const renderDocument = createDocumentRenderer({
  /** @param {string} source @returns {string} */
  hash: (source) => createHash("sha256").update(source).digest("hex"),
  createDiagrams: tikz,
  /** @returns {string|undefined} */
  get cacheDirectory() {
    return process.env.BANANAMARK_CACHE || undefined;
  },
});
