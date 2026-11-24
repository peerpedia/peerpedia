import { randomUUID } from "node:crypto";
import { UserFacingError } from "../user-error";
import { exactOrigin } from "./transport";
import type { CredentialStore } from "./types";

export interface SecretHost {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}
export type CredentialReferences = Readonly<Record<string, string>>;
export interface AccountCredentials extends CredentialStore {
  persistence(origin: string, username: string): "session" | "secret-storage";
}
const ownedSecret = /^peerpedia-token-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function accountKey(origin: string, username: string): string {
  exactOrigin(origin);
  if (!username.trim()) throw new UserFacingError("A username is required for saved credentials.");
  return JSON.stringify([origin, username]);
}

/** Secret values live in the host; plugin data contains only private secret references. */
export class HostCredentials implements AccountCredentials {
  private references: CredentialReferences;
  private readonly session = new Map<string, string>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly host: SecretHost, references: unknown,
    private readonly save: (references: CredentialReferences) => Promise<void>) {
    this.references = references && typeof references === "object" && !Array.isArray(references)
      ? Object.fromEntries(Object.entries(references).filter(
        (entry: [string, unknown]): entry is [string, string] => typeof entry[1] === "string" && ownedSecret.test(entry[1]),
      )) : {};
  }

  persistence(origin: string, username: string): "session" | "secret-storage" {
    return this.session.has(accountKey(origin, username)) ? "session" : "secret-storage";
  }

  async read(origin: string, username: string): Promise<string | null> {
    const key = accountKey(origin, username);
    const session = this.session.get(key);
    if (session) return session;
    const id = this.references[key];
    if (!id) return null;
    try { return this.host.getSecret(id); }
    catch { throw new UserFacingError("Unable to access Obsidian secret storage."); }
  }

  write(origin: string, username: string, token: string): Promise<void> {
    return this.serialize(async (): Promise<void> => {
      const key = accountKey(origin, username);
      if (!token) throw new UserFacingError("An access token is required.");
      // A new slot prevents a failed settings save from replacing the previous credential.
      const id = "peerpedia-token-" + randomUUID();
      try {
        this.host.setSecret(id, token);
        if (this.host.getSecret(id) !== token) throw new Error("Secret verification failed");
      } catch {
        this.clearUnused(id);
        this.session.set(key, token);
        return;
      }
      const previous = this.references[key];
      const next = { ...this.references, [key]: id };
      try { await this.save(next); }
      catch {
        this.clearUnused(id);
        throw new UserFacingError("Unable to save the credential reference. The previous saved token was preserved.");
      }
      this.references = next;
      this.session.delete(key);
      if (previous) this.clearUnused(previous);
    });
  }

  remove(origin: string, username: string): Promise<void> {
    return this.serialize(async (): Promise<void> => {
      const key = accountKey(origin, username);
      this.session.delete(key);
      const id = this.references[key];
      if (!id) return;
      try {
        // The public API removes a secret when assigned an empty value.
        this.host.setSecret(id, "");
        if (this.host.getSecret(id)) throw new Error("Secret removal failed");
        const next = { ...this.references };
        delete next[key];
        await this.save(next);
        this.references = next;
      } catch {
        throw new UserFacingError("Saved token removal could not be confirmed. Retry when Obsidian secret storage is available.");
      }
    });
  }

  private clearUnused(id: string): void {
    try { this.host.setSecret(id, ""); } catch { /* Preserve a host entry if cleanup is unavailable. */ }
  }

  private serialize(action: () => Promise<void>): Promise<void> {
    const operation = this.writes.then(action);
    this.writes = operation.catch((): void => {});
    return operation;
  }
}
