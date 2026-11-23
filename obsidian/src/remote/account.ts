import { exactOrigin } from "./transport";
import type { AccountIdentity, AccountInfo, CredentialStore, Transport } from "./types";

export const DEFAULT_ORIGIN = "https://peerpedia.dev";

function record(value: unknown): value is Record<string,unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !/[\x00-\x1f\x7f]/u.test(value);
}

export function storedIdentity(value: unknown): AccountIdentity | null {
  if (!record(value) || typeof value.origin !== "string" || !text(value.username)) return null;
  try {
    if (exactOrigin(value.origin).protocol !== "https:") return null;
    return {origin:value.origin, username:value.username};
  } catch { return null; }
}

export function decodeAccount(origin: string, value: unknown): AccountInfo {
  const base = exactOrigin(origin);
  const invalid = new Error("站点返回的账号信息不完整或格式错误。");
  if (!record(value) || !text(value.username) || !Array.isArray(value.scopes) || !value.scopes.every(text)
    || !text(value.expires_at) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value.expires_at)
    || !Number.isFinite(Date.parse(value.expires_at)) || !record(value.agreement)
    || !text(value.agreement.version) || typeof value.agreement.accepted !== "boolean" || !text(value.agreement.url)) throw invalid;
  let url: URL;
  try { url = new URL(value.agreement.url, base); }
  catch { throw invalid; }
  if (url.protocol !== base.protocol || url.origin !== origin || url.username || url.password) throw invalid;
  return {username:value.username, scopes:[...value.scopes], expiresAt:value.expires_at,
    agreement:{version:value.agreement.version, accepted:value.agreement.accepted, url:url.href}};
}

export async function connectAccount(origin: string, token: string, transport: Transport, credentials: CredentialStore,
  expectedUsername?: string, persistIdentity?: (identity: AccountIdentity) => Promise<void>): Promise<AccountInfo> {
  exactOrigin(origin);
  if (!token || !/^[\x21-\x7e]+$/u.test(token)) throw new Error("请输入有效的访问令牌。");
  const response = await transport.request(origin, "/api/v1/me/", "GET", {Authorization:"Bearer " + token, Accept:"application/json"}, null);
  if (response.status !== 200) throw new Error(`账号验证失败（HTTP ${response.status}）。`);
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(response.body)); }
  catch { throw new Error("站点返回了无效的账号数据。"); }
  const account = decodeAccount(origin, payload);
  if (expectedUsername !== undefined && account.username !== expectedUsername) throw new Error("令牌属于其他账号。请先断开当前账号。");
  if (account.username.includes(token)) throw new Error("站点返回的用户名包含访问令牌。");
  await persistIdentity?.({origin, username:account.username});
  await credentials.write(origin,account.username,token);
  return account;
}
