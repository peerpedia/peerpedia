import { expect, test } from "vitest";
import { HostCredentials, type CredentialReferences } from "../src/remote/host-credentials";

import { Secrets } from "./fixtures/secrets";

const origin = "https://peerpedia.invalid";

test("host credentials survive restart with only references in plugin settings and isolate sites and accounts", async (): Promise<void> => {
  const host = new Secrets();
  let settings: CredentialReferences = {};
  const save = async (next: CredentialReferences): Promise<void> => { settings = next; };
  const store = new HostCredentials(host, settings, save);
  await store.write(origin, "writer", "first-token");
  await store.write(origin, "other", "second-token");
  await store.write("https://another.invalid", "writer", "third-token");
  expect(JSON.stringify(settings)).not.toMatch(/first-token|second-token|third-token/);
  const restarted = new HostCredentials(host, settings, save);
  expect(await restarted.read(origin, "writer")).toBe("first-token");
  expect(await restarted.read(origin, "other")).toBe("second-token");
  expect(await restarted.read("https://another.invalid", "writer")).toBe("third-token");
  expect(restarted.persistence(origin, "writer")).toBe("secret-storage");
  await restarted.remove(origin, "writer");
  expect(await new HostCredentials(host, settings, save).read(origin, "writer")).toBeNull();
  expect(await restarted.read(origin, "other")).toBe("second-token");
});

test("failed reference persistence leaves the previous saved token intact", async (): Promise<void> => {
  const host = new Secrets();
  let settings: CredentialReferences = {};
  let fail = false;
  const save = async (next: CredentialReferences): Promise<void> => {
    if (fail) throw new Error("disk unavailable");
    settings = next;
  };
  const store = new HostCredentials(host, settings, save);
  await store.write(origin, "writer", "old-token");
  fail = true;
  await expect(store.write(origin, "writer", "replacement-token")).rejects.toThrow(/save/i);
  expect(await new HostCredentials(host, settings, save).read(origin, "writer")).toBe("old-token");
  expect([...host.values.values()]).toEqual(["old-token"]);
});

test("unavailable secret storage falls back to removable session memory without exposing host errors", async (): Promise<void> => {
  const host = new Secrets();
  host.unavailable = true;
  const store = new HostCredentials(host, {}, async (): Promise<void> => {});
  await store.write(origin, "writer", "session-token");
  expect(store.persistence(origin, "writer")).toBe("session");
  expect(await store.read(origin, "writer")).toBe("session-token");
  await store.remove(origin, "writer");
  expect(await store.read(origin, "writer")).toBeNull();
});

test("failed removal retains the reference for a restart retry and clears the session token", async (): Promise<void> => {
  const host = new Secrets();
  let settings: CredentialReferences = {};
  const save = async (next: CredentialReferences): Promise<void> => { settings = next; };
  const store = new HostCredentials(host, settings, save);
  await store.write(origin, "writer", "saved-token");
  host.unavailable = true;
  await store.write(origin, "writer", "session-token");
  await expect(store.remove(origin, "writer")).rejects.toThrow(/retry/i);
  await expect(store.read(origin, "writer")).rejects.toThrow(/^Unable to access Obsidian secret storage\.$/);
  host.unavailable = false;
  const restarted = new HostCredentials(host, settings, save);
  await restarted.remove(origin, "writer");
  expect(host.values.size).toBe(0);
});

test("concurrent credential saves preserve both account references", async (): Promise<void> => {
  const host = new Secrets();
  let settings: CredentialReferences = {};
  const store = new HostCredentials(host, settings, async (next: CredentialReferences): Promise<void> => {
    await Promise.resolve(); settings = next;
  });
  await Promise.all([store.write(origin, "one", "a"), store.write(origin, "two", "b")]);
  const restarted = new HostCredentials(host, settings, async (): Promise<void> => {});
  expect(await restarted.read(origin, "one")).toBe("a");
  expect(await restarted.read(origin, "two")).toBe("b");
});

test("legacy bindings without secret references require reconnection and do not touch other plugin secrets", async (): Promise<void> => {
  const host = new Secrets();
  host.setSecret("another-plugin-token", "unrelated");
  const key = JSON.stringify([origin, "writer"]);
  const store = new HostCredentials(host, {[key]:"another-plugin-token"}, async (): Promise<void> => {});
  expect(await store.read(origin, "writer")).toBeNull();
  await store.remove(origin, "writer");
  expect(host.getSecret("another-plugin-token")).toBe("unrelated");
});
