import type { App } from "obsidian";
import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { HostCredentials, type CredentialReferences } from "../src/remote/host-credentials";

/** Run only in the acceptance harness's disposable vault, never an installed plugin command. */
export async function probeHost(app: App, root: string): Promise<object> {
  const name = "host-api-probe.md";
  const file = await app.vault.create(name, "original");
  await app.vault.process(file, (current: string): string => {
    if (current !== "original") throw new Error("Unexpected source");
    return "modified";
  });
  const normalWrite = await app.vault.read(file) === "modified";
  await app.vault.adapter.write(name, "external edit");
  let staleReadRejected = false;
  try {
    await app.vault.process(file, (current: string): string => {
      if (current !== "modified") throw new Error("Conflict");
      return "overwrite";
    });
  } catch { staleReadRejected = true; }

  // An external editor can hold this descriptor across the host's write.
  const descriptor = openSync(join(root, name), "r+");
  let oldDescriptorReachesPublishedPath: boolean;
  try {
    await app.vault.process(file, (): string => "plugin version");
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, "late external", 0, "utf8");
    oldDescriptorReachesPublishedPath = readFileSync(join(root, name), "utf8") === "late external";
  } finally { closeSync(descriptor); }

  // Use hidden state for the deliberate directory replacement, without stale TFile objects.
  const directory = ".host-api-probe";
  mkdirSync(join(root, directory));
  writeFileSync(join(root, directory, "state.json"), "original");
  await app.vault.adapter.read(directory + "/state.json");
  renameSync(join(root, directory), join(root, directory + "-old"));
  mkdirSync(join(root, directory));
  writeFileSync(join(root, directory, "state.json"), "original");
  await app.vault.adapter.write(directory + "/state.json", "replacement written");
  const replacedDirectoryWritten = readFileSync(join(root, directory, "state.json"), "utf8") === "replacement written";

  let references: CredentialReferences = {};
  const save = async (next: CredentialReferences): Promise<void> => { references = next; };
  const credentials = new HostCredentials(app.secretStorage, references, save);
  await credentials.write("https://disposable.invalid", "fixture", "disposable-token");
  const reloaded = new HostCredentials(app.secretStorage, references, save);
  const hostSecretRoundTrip = await reloaded.read("https://disposable.invalid", "fixture") === "disposable-token";
  await reloaded.remove("https://disposable.invalid", "fixture");
  const hostSecretRemoved = await reloaded.read("https://disposable.invalid", "fixture") === null;
  return {normalWrite,staleReadRejected,oldDescriptorReachesPublishedPath,replacedDirectoryWritten,
    hostSecretRoundTrip,hostSecretRemoved,credentialPersistence:credentials.persistence("https://disposable.invalid","fixture")};
}
