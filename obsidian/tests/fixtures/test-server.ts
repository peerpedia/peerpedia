import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { PublicationDocument } from "../../src/project/publication";
import { sourceDigest } from "../../src/project/store";
import { receipt, rehash, type Receipt } from "./publishing";

interface Counts { papers: number; snapshots: number; proposals: number }
export interface JourneySite {
  origin: string;
  close: () => Promise<void>;
  username: string;
  token: string;
  accept(id: string): Promise<void>;
  counts(): Promise<Counts>;
  loseNextResponse?: () => void;
}

export interface FixtureServer extends JourneySite { loseNextResponse(): void }

type Payload = PublicationDocument & {paper_id: string | null; base_hash: string | null; explanation: string;
  ai_assisted: boolean; pull_request_id?: string; expected_head?: string};

function snapshot(data: Payload, prId: string | undefined, ordinal: number): Receipt {
  const row = receipt(data.base_hash, prId, ordinal);
  const digest = (s: string): string => sourceDigest(Buffer.from(s));
  row.chapters = data.chapters.map((c: PublicationDocument["chapters"][number]): Receipt["chapters"][number] => ({...c}));
  row.bibliography = data.bibliography;
  row.markdown = data.markdown;
  row.ai_assisted = data.ai_assisted;
  Object.assign(row.manifest, {submission_id: randomUUID(), title: data.title, authors: data.authors,
    abstract: data.abstract, primary_category: data.primary_category, secondary_categories: data.secondary_categories,
    license: data.license, explanation: data.explanation, markdown_sha256: digest(data.markdown),
    bibliography_sha256: digest(data.bibliography), chapters: row.chapters.map((c: Receipt["chapters"][number]): Receipt["manifest"]["chapters"][number] =>
      ({id: c.id, title: c.title, markdown_sha256: digest(c.markdown)}))});
  return rehash(row);
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const token = randomUUID();
  const username = "fixture-author";
  const records = new Map<string, Receipt>();
  const acceptedKeys = new Map<string, {body: string; row: Receipt}>();
  const heads = new Map<string, Receipt>();
  let current: Receipt | undefined;
  let drop = false;
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (status: number, data: unknown): void => {
      res.writeHead(status, {"Content-Type": "application/json"});
      res.end(JSON.stringify(data));
    };
    const path = req.url;
    const authenticated = req.headers.authorization === "Bearer " + token;
    if (path === "/api/v1/me/") {
      reply(authenticated ? 200 : 401, {username, scopes: ["publish", "propose"], expires_at: "2099-01-01T00:00:00Z",
        agreement: {version: "1", accepted: true, url: "/agreement/"}});
    } else if (path === "/api/v1/categories/") {
      reply(200, {categories: [{code: "math.AG", name: "Algebraic Geometry"}]});
    } else if (path === "/api/v1/licenses/") {
      reply(200, {licenses: [{code: "CC-BY-4.0", label: "CC BY 4.0", url: "/license/"}]});
    } else if (current && path === "/api/v1/papers/" + current.manifest.paper_id + "/") {
      reply(200, {paper_id: current.manifest.paper_id, paper_identifier: current.paper_identifier, current});
    } else if (current && path === "/api/v1/papers/" + current.manifest.paper_id + "/prs/") {
      const prs = [...heads.entries()].map(([id, row]: [string, Receipt]): object => ({id, contributor: username,
        head_hash: row.hash, head_id: row.manifest.submission_id, status: row.status}));
      reply(200, {paper_id: current.manifest.paper_id, prs, next: null});
    } else if (path?.startsWith("/api/v1/submissions/")) {
      const row = records.get(path.split("/")[4]);
      reply(row ? 200 : 404, row ?? {});
    } else if (req.method === "POST" && path === "/api/v1/push/" && authenticated) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const key = String(req.headers["idempotency-key"]);
      const existing = acceptedKeys.get(key);
      if (existing) {
        if (body === existing.body) reply(200, existing.row);
        else reply(409, {error: {code: "idempotency_conflict"}});
        return;
      }
      const data: Payload = JSON.parse(body);
      if (data.paper_id && current?.hash !== data.base_hash) { reply(409, {error: {code: "stale_base"}}); return; }
      const prId = data.paper_id ? data.pull_request_id ?? randomUUID() : undefined;
      const prior = prId ? heads.get(prId) : undefined;
      if (data.pull_request_id && (!prior || prior.hash !== data.expected_head || prior.status !== "pending")) {
        reply(409, {error: {code: "stale_pr"}}); return;
      }
      const row = snapshot(data, prId, (prior?.pull_request?.snapshot ?? 0) + 1);
      if (prior) prior.status = "superseded";
      if (prId) heads.set(prId, row);
      else current = row;
      records.set(row.manifest.submission_id, row);
      acceptedKeys.set(key, {body, row});
      if (drop) { drop = false; res.destroy(); } else reply(201, row);
    } else reply(404, {});
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((): void => { res.destroy(); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {origin: "http://127.0.0.1:" + (server.address() as AddressInfo).port, username, token,
    loseNextResponse(): void { drop = true; },
    async accept(id: string): Promise<void> {
      const row = records.get(id);
      if (!row?.pull_request || heads.get(row.pull_request.id) !== row) throw new Error("Expected current proposal head");
      row.status = "accepted";
      current = row;
    },
    async counts(): Promise<Counts> { return {papers: Number(!!current), snapshots: records.size, proposals: heads.size}; },
    async close(): Promise<void> { const closed = once(server, "close"); server.close(); await closed; }};
}

// The private pipe controls the test owner's website decision. All plugin traffic goes through the actual WSGI API.
export async function startDjangoServer(): Promise<JourneySite> {
  const python = process.env.PEERPEDIA_PG_PYTHON ?? process.env.PEERPEDIA_TEST_PYTHON ?? "python3";
  const script = fileURLToPath(new URL("./django-server.py", import.meta.url));
  const child = spawn(python, ["-u", script], {stdio: ["pipe", "pipe", "inherit"],
    env: {PATH: process.env.PATH, PEERPEDIA_TEST_PYTHON: process.env.PEERPEDIA_TEST_PYTHON, PYTHONDONTWRITEBYTECODE: "1"}});
  const exited = once(child, "close");
  const lines = createInterface({input: child.stdout})[Symbol.asyncIterator]();
  async function read<T>(): Promise<T> {
    const line = await lines.next();
    if (line.done) throw new Error("The isolated Django process stopped before replying.");
    return JSON.parse(line.value);
  }
  try {
    const identity = await read<{origin: string; username: string; token: string}>();
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(identity.origin)) throw new Error("Expected a disposable loopback site");
    return {...identity, async accept(id: string): Promise<void> {
      child.stdin.write(JSON.stringify({accept: id}) + "\n");
      if (!(await read<{accepted: boolean}>()).accepted) throw new Error("Test owner decision failed");
    }, async counts(): Promise<Counts> {
      child.stdin.write('"counts"\n');
      return read<Counts>();
    }, async close(): Promise<void> {
      child.stdin.end();
      if ((await exited)[0] !== 0) throw new Error("The Django fixture exited with an error.");
    }};
  } catch (error: unknown) {
    child.stdin.end();
    await exited;
    throw error;
  }
}
