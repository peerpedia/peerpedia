/// <reference path="./vendor.d.ts" />
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { tikz } from "bananamark-tikz";
import { createDocumentRenderer } from "../core.mjs";

export const renderDocument = createDocumentRenderer({
  hash(source: string): string {
    return bytesToHex(sha256(new TextEncoder().encode(source)));
  },
  createDiagrams: tikz,
});
