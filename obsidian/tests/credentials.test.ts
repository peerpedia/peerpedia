import { randomUUID } from "node:crypto";
import { expect, test, vi } from "vitest";

import { connectAccount } from "../src/remote/account";
import type { CredentialStore, Transport } from "../src/remote/types";

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
