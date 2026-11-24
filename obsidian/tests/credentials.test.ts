import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

import { DeviceCredentials } from "../src/remote/credentials";
import { connectAccount } from "../src/remote/account";
import type { CredentialStore, Transport } from "../src/remote/types";

const run = promisify(execFile);
const sample = {username: "writer", scopes: ["propose"], expires_at: "2030-01-01T00:00:00+00:00",
  agreement: {version: "2026", accepted: false, url: "/agreements/"}};
const origin = "https://peerpedia.invalid";

test("only saves after /me/ validates scope, expiry and the same-origin agreement", async (): Promise<void> => {
  let payload: unknown = sample;
  let status = 200;
  const transport: Transport = {request: vi.fn(async (): Promise<{status:number; headers:Record<string,string>; body:Uint8Array}> =>
    ({status, headers:{}, body:Buffer.from(JSON.stringify(payload))}))};
  const credentials: CredentialStore = {write:vi.fn(), read:vi.fn(), remove:vi.fn()};
  const token = randomUUID();
  for (payload of [{}, {...sample, scopes:"propose"}, {...sample, expires_at:"tomorrow"},
    {...sample, agreement:{...sample.agreement, accepted:1}}, {...sample, agreement:{...sample.agreement, url:"https://foreign.invalid/"}}]) {
    await expect(connectAccount(origin, token, transport, credentials)).rejects.toThrow();
  }
  payload = sample;
  status = 401;
  await expect(connectAccount(origin, token, transport, credentials)).rejects.toThrow();
  expect(credentials.write).not.toHaveBeenCalled();
  status = 200;
  await expect(connectAccount(origin, token, transport, credentials, "another-account")).rejects.toThrow(/another account/i);
  expect(credentials.write).not.toHaveBeenCalled();
  expect(await connectAccount(origin, token, transport, credentials)).toMatchObject({
    username:"writer", scopes:["propose"], expiresAt:sample.expires_at,
    agreement:{accepted:false, url:origin + "/agreements/"},
  });
  expect(transport.request).toHaveBeenLastCalledWith(origin, "/api/v1/me/", "GET",
    expect.objectContaining({Authorization:"Bearer " + token}), null);
  expect(credentials.write).toHaveBeenCalledWith(origin, "writer", token);
});

test.each([null, "old-token"])("failed identity persistence preserves existing credential %s", async (previous: string | null): Promise<void> => {
  let saved = previous;
  const store: CredentialStore = {read:vi.fn(), remove:vi.fn(), write:vi.fn(async (_origin:string, _user:string, token:string):Promise<void> => { saved = token; })};
  const transport: Transport = {request:vi.fn(async ():Promise<{status:number;headers:Record<string,string>;body:Uint8Array}> =>
    ({status:200,headers:{},body:Buffer.from(JSON.stringify(sample))}))};
  const persist = vi.fn(async ():Promise<void> => { throw new Error("storage unavailable"); });
  await expect(connectAccount(origin,"new-token",transport,store,previous ? sample.username : undefined,persist)).rejects.toThrow("storage unavailable");
  expect(persist).toHaveBeenCalledWith({origin,username:sample.username});
  expect(store.write).not.toHaveBeenCalled();
  expect(saved).toBe(previous);
});

test("unavailable Keychain uses isolated, removable session memory", async (): Promise<void> => {
  const credentials = new DeviceCredentials("/nonexistent-peerpedia-helper");
  await credentials.write(origin, "writer", "memory-value");
  expect(credentials.persistence(origin, "writer")).toBe("session");
  expect(await credentials.read(origin, "writer")).toBe("memory-value");
  const other = new DeviceCredentials("/nonexistent-peerpedia-helper");
  await expect(other.read(origin, "writer")).rejects.toThrow();
  await expect(credentials.remove(origin, "writer")).rejects.toThrow(/try again/i);
  await expect(credentials.read(origin, "writer")).rejects.toThrow();
});

test.skipIf(process.platform !== "darwin")("real helper writes, reads and deletes a unique temporary generic password", async (): Promise<void> => {
  const folder = await mkdtemp(join(tmpdir(), "peerpedia-keychain-"));
  const helper = join(folder, "keychain");
  const testOrigin = "https://" + randomUUID() + ".invalid";
  const user = "synthetic-r1";
  const token = randomUUID();
  const store = new DeviceCredentials(helper);
  try {
    await run("xcrun", ["swiftc", "-O", fileURLToPath(new URL("../native/keychain.swift", import.meta.url)), "-o", helper]);
    try {
      expect(await store.read(testOrigin, user)).toBeNull();
      await store.write(testOrigin, user, token);
      expect(store.persistence(testOrigin, user)).toBe("keychain");
      expect(await new DeviceCredentials(helper).read(testOrigin,user)).toBe(token);
      await store.write(testOrigin, user, token + "-updated");
      expect(await store.read(testOrigin,user)).toBe(token + "-updated");
    } finally {
      await store.remove(testOrigin,user);
    }
    expect(await new DeviceCredentials(helper).read(testOrigin,user)).toBeNull();
  } finally {
    await rm(folder, {recursive:true,force:true});
  }
}, 60_000);


test("helper receives only stdin, and failures never echo helper stderr or tokens", async (): Promise<void> => {
  const folder = await mkdtemp(join(tmpdir(), "peerpedia-stdin-"));
  const helper = join(folder,"helper.cjs");
  const token = randomUUID();
  const diagnostics = [vi.spyOn(console,"log"), vi.spyOn(console,"warn"), vi.spyOn(console,"error")];
  try {
    // This synthetic executable refuses argv data and intentionally emits its input on failure.
    await writeFile(helper, `#!${process.execPath}
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (process.argv.length !== 2 || !input.origin || !input.username) process.exit(4);
if (input.operation === "write" && input.token) process.stdout.write('{"ok":true}');
else { process.stderr.write(JSON.stringify(input)); process.exit(3); }
`, {mode:0o700});
    const store = new DeviceCredentials(helper);
    await store.write(origin,"writer",token);
    expect(store.persistence(origin,"writer")).toBe("keychain");
    await expect(store.read(origin,token)).rejects.toThrow(/^Unable to access this Mac’s Keychain\.$/);
    expect(diagnostics.every((spy: typeof diagnostics[number]): boolean => spy.mock.calls.length === 0)).toBe(true);
  } finally {
    for (const spy of diagnostics) spy.mockRestore();
    await rm(folder,{recursive:true,force:true});
  }
});
