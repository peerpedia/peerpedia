import type { Vault } from "obsidian";
import { VaultProjectStore } from "../../src/host/vault-store";
import { prepareSubmission } from "../../src/remote/submit";
import { account,details,root } from "./publishing";

Object.assign(globalThis,{__PEERPEDIA_ANCHORED__:process.env.PEERPEDIA_TEST_ANCHORED});
const store = new VaultProjectStore(process.argv[2],{} as Pick<Vault,"on"|"offref">);
const request = prepareSubmission(await store.read(root),null,account,"publish",details);
try {
  await store.submissions.persistRequest(root,request);
  process.stdout.write("unexpected new request");
} catch (error:unknown) {
  process.stdout.write(error instanceof Error ? error.message : "unknown failure");
}
