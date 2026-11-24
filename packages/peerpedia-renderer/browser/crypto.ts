import { sha256 } from "@noble/hashes/sha2.js";
import { md5 } from "@noble/hashes/legacy.js";
interface Hash {
  update(input: string | Uint8Array): Hash;
  digest(encoding: "hex"): string;
}
export function createHash(algorithm: string): Hash {
  if (algorithm !== "sha256" && algorithm !== "md5")
    throw new Error("Unsupported digest");
  const hash = (algorithm === "sha256" ? sha256 : md5).create();
  const result: Hash = {
    update(input: string | Uint8Array): Hash {
      hash.update(
        typeof input === "string" ? new TextEncoder().encode(input) : input,
      );
      return result;
    },
    digest(encoding: "hex"): string {
      if (encoding !== "hex") throw new Error("Expected hex");
      return Array.from(hash.digest(), (byte: number): string =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    },
  };
  return result;
}
