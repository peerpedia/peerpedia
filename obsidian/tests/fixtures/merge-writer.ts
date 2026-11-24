import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { Vault } from "obsidian";
import { VaultProjectStore } from "../../src/host/vault-store";
import { AnchoredFiles } from "../../src/project/anchored-files";
import type { FileChange, MergeCommit } from "../../src/project/store";

interface Input { vault: string; root: string; revision: string; changes: FileChange[]; merge: MergeCommit }
Object.assign(globalThis,{__PEERPEDIA_ANCHORED__:process.env.PEERPEDIA_TEST_ANCHORED});
const input: Input = JSON.parse(await readFile(process.argv[2],"utf8"));
const store = new VaultProjectStore(input.vault,{} as Pick<Vault,"on"|"offref">);
const write = AnchoredFiles.prototype.file;
AnchoredFiles.prototype.file = async function(this: AnchoredFiles, path: string, text: string, mode?: number): Promise<void> {
  if (path.endsWith("/journal.json")) {
    // The merge intent has already been published and synced at this boundary.
    const resume = once(process,"message");
    process.send!("before-journal");
    await resume;
  }
  await write.call(this,path,text,mode);
};
await store.apply(input.root,input.revision,input.changes,input.merge);
process.disconnect();
