import type { SecretHost } from "../../src/remote/host-credentials";

export class Secrets implements SecretHost {
  values = new Map<string, string>();
  unavailable = false;
  getSecret(id: string): string | null {
    if (this.unavailable) throw new Error("sensitive host failure");
    return this.values.get(id) || null;
  }
  setSecret(id: string, value: string): void {
    if (this.unavailable) throw new Error("sensitive host failure");
    if (value) this.values.set(id, value); else this.values.delete(id);
  }
}
