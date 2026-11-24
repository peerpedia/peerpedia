import { UserFacingError } from "../user-error";
import { execFile } from "node:child_process";
import { exactOrigin } from "./transport";
import type { CredentialStore } from "./types";

type Operation = "read" | "write" | "remove";
const unavailable = "Unable to access this Mac’s Keychain.";

function credentialKey(origin: string, username: string): string {
  exactOrigin(origin);
  if (!username.trim()) throw new UserFacingError("A username is required for saved credentials.");
  return JSON.stringify([origin,username]);
}

export class DeviceCredentials implements CredentialStore {
  private readonly session = new Map<string,string>();
  constructor(private readonly helper: string) {}

  persistence(origin: string, username: string): "session" | "keychain" {
    return this.session.has(credentialKey(origin, username)) ? "session" : "keychain";
  }

  private invoke(operation: Operation, origin: string, username: string, token?: string): Promise<string | null> {
    return new Promise<string | null>((resolve: (result: string | null) => void, reject: (error: Error) => void): void => {
      const fail = (): void => reject(new UserFacingError(unavailable));
      const child = execFile(this.helper, [], {timeout:10_000, maxBuffer:64 * 1024, encoding:"utf8"},
        (error: Error | null, stdout: string): void => {
          if (error) { fail(); return; }
          try {
            const reply: unknown = JSON.parse(stdout);
            if (!reply || typeof reply !== "object" || !("ok" in reply) || reply.ok !== true) { fail(); return; }
            if ("token" in reply) {
              if (operation !== "read" || typeof reply.token !== "string" || !reply.token) { fail(); return; }
              resolve(reply.token);
            } else resolve(null);
          } catch { fail(); }
        });
      child.stdin?.on("error", fail);
      child.stdin?.end(JSON.stringify({operation, origin, username, token}));
    });
  }

  async read(origin: string, username: string): Promise<string | null> {
    const key = credentialKey(origin, username);
    return this.session.get(key) ?? await this.invoke("read",origin,username);
  }

  async write(origin: string, username: string, token: string): Promise<void> {
    const key = credentialKey(origin, username);
    if (!token) throw new UserFacingError("An access token is required.");
    try {
      await this.invoke("write",origin,username,token);
      this.session.delete(key);
    } catch {
      this.session.set(key,token);
    }
  }

  async remove(origin: string, username: string): Promise<void> {
    this.session.delete(credentialKey(origin, username));
    try { await this.invoke("remove",origin,username); }
    catch { throw new UserFacingError("Keychain removal could not be confirmed. Restore access to Keychain and try again."); }
  }
}
