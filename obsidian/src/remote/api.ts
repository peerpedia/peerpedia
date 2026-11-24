import { decodeAccount } from "./account";
import { isPublicId, isUuid } from "./links";
import { exactOrigin } from "./transport";
import type { AccountInfo, Category, LicenseOption, PrHead, Transport, VerifiedSnapshot } from "./types";
import { array, checksum, nonempty, object, ProtocolError, readStatus, verifySnapshot } from "./verify";

export class HttpStatusError extends Error {
  constructor(readonly status: number) { super(`站点请求失败（HTTP ${status}）。`); }
}

function identifier(value: string): string {
  if (!isUuid(value) && !isPublicId(value)) throw new ProtocolError();
  return value;
}

function prHead(raw: unknown): PrHead {
  const row = object(raw);
  const status = readStatus(row.status);
  if (!isUuid(row.id) || !isUuid(row.head_id) || status === "superseded") throw new ProtocolError();
  return {id: row.id, hash: checksum(row.head_hash), submissionId: row.head_id, owner: nonempty(row.contributor), status};
}

function licenseOption(raw: unknown, origin: string): LicenseOption {
  const row = object(raw);
  let url: URL;
  try { url = new URL(nonempty(row.url), origin); } catch { throw new ProtocolError(); }
  const localHttp = url.protocol === "http:" && url.origin === origin;
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password) throw new ProtocolError();
  return {code: nonempty(row.code), label: nonempty(row.label), url: url.href};
}

export function decodeJson(body: Uint8Array): unknown {
  try {
    const source = new TextDecoder("utf-8", {fatal: true}).decode(body);
    // Check the numeric lexeme before trusting its rounded JS representation.
    return JSON.parse(source, (_key: string, value: unknown, context?: {source?: string}): unknown => {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0)
        || context?.source !== String(value))) throw new ProtocolError();
      return value;
    });
  } catch { throw new ProtocolError(); }
}

export interface ProposalSnapshot {
  snapshot: VerifiedSnapshot;
  proposal: {id:string; number:number} | null;
}

export class PeerpediaApi {
  constructor(readonly origin: string, private readonly transport: Transport) { exactOrigin(origin); }

  private async get(route: string, token?: string): Promise<unknown> {
    const headers: Record<string, string> = {Accept: "application/json"};
    if (token !== undefined) {
      if (!/^[\x21-\x7e]+$/u.test(token)) throw new Error("请输入有效的访问令牌。");
      headers.Authorization = "Bearer " + token;
    }
    const response = await this.transport.request(this.origin, "/api/v1/" + route, "GET", headers, null);
    if (response.status !== 200) throw new HttpStatusError(response.status);
    return decodeJson(response.body);
  }

  async current(paperId: string): Promise<VerifiedSnapshot> {
    const wrapper = object(await this.get("papers/" + identifier(paperId) + "/"));
    const raw = object(wrapper.current);
    const result = verifySnapshot(raw);
    if (result.status !== "accepted" || result.paperId !== wrapper.paper_id
      || wrapper.paper_identifier !== raw.paper_identifier
      || (wrapper.paper_identifier !== null && !isPublicId(wrapper.paper_identifier))
      || (isUuid(paperId) ? result.paperId !== paperId : wrapper.paper_identifier !== paperId)) throw new ProtocolError();
    return result;
  }

  async snapshot(id: string): Promise<VerifiedSnapshot> {
    const {snapshot} = await this.proposalSnapshot(id);
    return snapshot;
  }

  async proposalSnapshot(id: string): Promise<ProposalSnapshot> {
    const row = object(await this.get("submissions/" + identifier(id) + "/"));
    const result = verifySnapshot(row);
    if ((isUuid(id) ? result.submissionId : result.publicId) !== id) throw new ProtocolError();
    if (row.pull_request == null) return {snapshot:result,proposal:null};
    const pr = object(row.pull_request);
    if (!isUuid(pr.id) || typeof pr.snapshot !== "number" || !Number.isSafeInteger(pr.snapshot) || pr.snapshot < 1) throw new ProtocolError();
    return {snapshot:result,proposal:{id:pr.id,number:pr.snapshot}};
  }

  async prs(paperId: string): Promise<readonly PrHead[]> {
    if (!isUuid(paperId)) throw new ProtocolError();
    const route = "papers/" + paperId + "/prs/";
    const heads: PrHead[] = [];
    let offset = 0;
    for (;;) {
      const page = object(await this.get(offset ? route + "?offset=" + offset : route));
      if (page.paper_id !== paperId) throw new ProtocolError();
      for (const row of array(page.prs)) heads.push(prHead(row));
      const next = page.next;
      if (next === null) return heads;
      if (typeof next !== "number" || !Number.isSafeInteger(next) || next <= offset || next > 1_000_000) throw new ProtocolError();
      offset = next;
    }
  }

  async me(token: string): Promise<AccountInfo> {
    const raw = await this.get("me/", token);
    try { return decodeAccount(this.origin, raw); } catch { throw new ProtocolError(); }
  }

  async categories(): Promise<readonly Category[]> {
    const raw = object(await this.get("categories/"));
    return array(raw.categories).map((item: unknown): Category => {
      const row = object(item);
      return {id: nonempty(row.code), name: nonempty(row.name)};
    });
  }

  async licenses(): Promise<readonly LicenseOption[]> {
    const raw = object(await this.get("licenses/"));
    return array(raw.licenses).map((item: unknown): LicenseOption => licenseOption(item, this.origin));
  }
}
