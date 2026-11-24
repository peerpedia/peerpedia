import { expect, test } from "vitest";
import { PeerpediaApi, HttpStatusError } from "../src/remote/api";
import { TransportError } from "../src/remote/transport";
import type { HttpResponse, Transport } from "../src/remote/types";
import { ProtocolError, verifySnapshot } from "../src/remote/verify";
import v1 from "../../tests/fixtures/publication-protocol/v1.json";
import v2 from "../../tests/fixtures/publication-protocol/v2.json";
import v3 from "../../tests/fixtures/publication-protocol/v3.json";
import v4 from "../../tests/fixtures/publication-protocol/v4.json";

const origin = "https://fixture.example";
const paper = v4.manifest.paper_id;
const submission = v4.manifest.submission_id;
const current = {paper_id: paper, paper_identifier: v4.paper_identifier, current: v4};

function json(value: unknown): HttpResponse {
  return {status: 200, headers: {}, body: Buffer.from(JSON.stringify(value))};
}

class Responses implements Transport {
  readonly routes: string[] = [];
  readonly authorization: (string | undefined)[] = [];
  constructor(private readonly responses: (HttpResponse | Error)[]) {}
  async request(site: string, route: string, method: "GET" | "POST", headers: Readonly<Record<string, string>>,
    body: Uint8Array | null): Promise<HttpResponse> {
    expect([site, method, body]).toEqual([origin, "GET", null]);
    this.routes.push(route);
    this.authorization.push(headers.Authorization);
    const next = this.responses.shift();
    if (!next) throw new Error("Unexpected extra request");
    if (next instanceof Error) throw next;
    return next;
  }
}

test("preserves the exact content and hashed metadata of all four Django / CLI records", (): void => {
  for (const raw of [v1, v2, v3, v4]) {
    const verified = verifySnapshot(raw);
    expect(verified).toMatchObject({paperId: paper, submissionId: raw.manifest.submission_id, publicId: raw.snapshot_identifier,
      hash: raw.hash, status: "accepted", manifest: raw.manifest,
      document: {title: raw.manifest.title, authors: raw.manifest.authors, abstract: raw.manifest.abstract,
        markdown: raw.markdown, chapters: raw.chapters, bibliography: raw.bibliography}});
  }
  expect(verifySnapshot({...v1, licensing: {code: "unverified"}}).document)
    .toMatchObject({primary_category: "", secondary_categories: [], license: ""});
  expect(verifySnapshot(v2).document).toMatchObject({primary_category: "cs.AI", secondary_categories: ["cs.PL", "math.AG"], license: ""});
  expect(verifySnapshot(v3).document.license).toBe("CC-BY-4.0");
  expect(verifySnapshot({...v4, status: "superseded"}).status).toBe("superseded");
});

test("rejects body, chapter order, title, bibliography, manifest, ID, status and Unicode tampering", (): void => {
  const [first, second] = v4.chapters;
  for (const patch of [
    {markdown: v4.markdown.replaceAll("\r\n", "\n")}, {chapters: [second, first]},
    {chapters: [{...first, title: "替换"}, second]}, {chapters: [{...first, markdown: first.markdown.normalize("NFD") + " "}, second]},
    {bibliography: v4.bibliography.replaceAll("\r", "")}, {manifest: {...v4.manifest, abstract: "changed"}},
    {snapshot_identifier: "240228." + v4.hash.slice(0, 12)}, {snapshot_identifier: "240229.0123456789ab"},
    {snapshot_identifier: ""}, {status: "unknown"}, {markdown: "\ud800"}, {bibliography: "\udfff"},
    {manifest: {...v4.manifest, title: "\ud800"}}, {manifest: {...v4.manifest, format: "peerpedia-submission-v5"}},
  ]) expect((): unknown => verifySnapshot({...v4, ...patch})).toThrow(ProtocolError);
  for (const patch of [{chapters: [first]}, {bibliography: v4.bibliography}])
    expect((): unknown => verifySnapshot({...v1, ...patch})).toThrow(ProtocolError);
});

test("matches Python code-point ordering for astral, BMP and numeric object keys", (): void => {
  const extensions = {"10": null, "2": true, "\ue000": "\u0000\n", "𐀀": false};
  const hash = "92fb36472305ec51926d2c64a6f5674931acf8126d4eab32f42480ee6d86925c";
  const raw = {...v1, hash, snapshot_identifier: null, manifest: {...v1.manifest, extensions}};
  expect(verifySnapshot(raw).manifest.extensions).toEqual(extensions);
  for (const unsupported of [NaN, Infinity, -0, 1.5, 2 ** 53, 1n, undefined, new Date(), "\ud800"])
    expect((): unknown => verifySnapshot({...raw, manifest: {...raw.manifest, extensions: unsupported}})).toThrow(ProtocolError);
});

test("resolves accepted paper and exact snapshot endpoints by UUID and public ID", async (): Promise<void> => {
  const transport = new Responses([json(current), json(current), json(v4), json(v4)]);
  const api = new PeerpediaApi(origin, transport);
  expect(transport.routes).toEqual([]);
  for (const id of [paper, v4.paper_identifier]) expect((await api.current(id)).paperId).toBe(paper);
  for (const id of [submission, v4.snapshot_identifier]) expect((await api.snapshot(id)).submissionId).toBe(submission);
  expect(transport.routes).toEqual([`/api/v1/papers/${paper}/`, `/api/v1/papers/${v4.paper_identifier}/`,
    `/api/v1/submissions/${submission}/`, `/api/v1/submissions/${v4.snapshot_identifier}/`]);
  expect(transport.authorization).toEqual([undefined, undefined, undefined, undefined]);
});

test("rejects a different resolved identity, mismatched wrapper and nonaccepted current", async (): Promise<void> => {
  const transport = new Responses([json(current), json(current), json({...current, paper_id: submission}),
    json({...current, current: {...v4, paper_identifier: v4.snapshot_identifier}}),
    json({...current, current: {...v4, status: "pending"}}), json(v4), json(v4)]);
  const api = new PeerpediaApi(origin, transport);
  for (const target of [submission, v4.snapshot_identifier, v4.paper_identifier, paper, paper])
    await expect(api.current(target)).rejects.toThrow(ProtocolError);
  for (const target of [paper, v4.paper_identifier]) await expect(api.snapshot(target)).rejects.toThrow(ProtocolError);
  await expect(api.snapshot("../me")).rejects.toThrow();
  expect(transport.routes).toHaveLength(7);
});

test("projects only PR head fields and follows numeric forward offsets on the same paper", async (): Promise<void> => {
  const head = {id: submission, head_id: submission, head_hash: v4.hash, contributor: "author", status: "pending",
    explanation: "not needed for sync", url: "/ignored/"};
  const page = {paper_id: paper, prs: [head], next: 100};
  const api = (responses: unknown[]): PeerpediaApi => new PeerpediaApi(origin, new Responses(responses.map(json)));
  const transport = new Responses([json(page), json({...page, prs: [{...head, id: paper, status: "withdrawn"}], next: null})]);
  const resolved = await new PeerpediaApi(origin, transport).prs(paper);
  expect(resolved).toEqual(["pending", "withdrawn"].map((status: string, index: number): object =>
    ({id: index ? paper : submission, owner: "author", submissionId: submission, hash: v4.hash, status})));
  expect(transport.routes).toEqual([`/api/v1/papers/${paper}/prs/`, `/api/v1/papers/${paper}/prs/?offset=100`]);
  for (const bad of [{...page, next: 0}, {...page, next: "https://other/"}, {...page, paper_id: submission},
    {...page, prs: [{...head, status: "superseded"}]}]) await expect(api([bad]).prs(paper)).rejects.toThrow(ProtocolError);
  await expect(api([page, page]).prs(paper)).rejects.toThrow(ProtocolError);
});

test("reads actual account, license and taxonomy shapes, retaining credentials only in the me request", async (): Promise<void> => {
  const transport = new Responses([json({username: "writer", scopes: ["propose"], expires_at: "2027-01-01T00:00:00Z",
    agreement: {version: "1", accepted: true, url: "/agreements/"}}),
    json({categories: [{code: "cs.AI", name: "Artificial Intelligence", group: "CS"}]}),
    json({licenses: [{code: "LicenseRef-Peerpedia-1.0", label: "Peerpedia", url: "/terms/#distribution", description: "..." }]})]);
  const api = new PeerpediaApi(origin, transport);
  expect((await api.me("test-token")).agreement.url).toBe(origin + "/agreements/");
  expect(await api.categories()).toEqual([{id: "cs.AI", name: "Artificial Intelligence"}]);
  expect(await api.licenses()).toEqual([{code: "LicenseRef-Peerpedia-1.0", label: "Peerpedia", url: origin + "/terms/#distribution"}]);
  expect(transport.routes).toEqual(["/api/v1/me/", "/api/v1/categories/", "/api/v1/licenses/"]);
  expect(transport.authorization).toEqual(["Bearer test-token", undefined, undefined]);
});

test("separates network and HTTP failures from malformed UTF-8, lossy numbers and invalid JSON", async (): Promise<void> => {
  const network = new TransportError("network");
  const encoded = JSON.stringify(v1);
  const transport = new Responses([network, {...json({}), status: 404},
    {...json({}), body: Buffer.from([0x22, 0xc3, 0x28, 0x22])}, {...json({}), body: Buffer.from("{")},
    {...json({}), body: Buffer.from(encoded.replace('"contributor_id":7', '"contributor_id":7.00000000000000000001'))}]);
  const api = new PeerpediaApi(origin, transport);
  await expect(api.snapshot(submission)).rejects.toBe(network);
  await expect(api.snapshot(submission)).rejects.toThrow(HttpStatusError);
  for (let attempt = 0; attempt < 3; attempt++)
    await expect(api.snapshot(v1.manifest.submission_id)).rejects.toThrow(ProtocolError);
});

test("validates schema and UTF-8 even when the supplied manifest hash matches Python", (): void => {
  const replacement = {...v1, snapshot_identifier: null, hash: "246c41a3b9d0d756e14b77fb5cbddcfa5125bf6c1df9b6c5b4012b596f0b5924",
    manifest: {...v1.manifest, markdown_sha256: "83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097"}};
  expect(verifySnapshot({...replacement, markdown: "\ufffd"}).document.markdown).toBe("\ufffd");
  expect((): unknown => verifySnapshot({...replacement, markdown: "\ud800"})).toThrow(ProtocolError);

  const shift = {...v1, snapshot_identifier: "240229.71257db84297",
    hash: "71257db84297a9bb5917dc61b2d3f9f9a312952a226055bf0583c2d3bd7b1148",
    manifest: {...v1.manifest, submitted_at: "2024-03-01T00:30:00.123456+02:00"}};
  expect(verifySnapshot(shift).publicId).toBe(shift.snapshot_identifier);
  for (const [base, patch, hash] of [
    [v1, {submitted_at: "2024-02-31T00:00:00+00:00"}, "06ff10c5047864062eb0824499a157611bddd5dbdd8af5ddc2520ba8b44d67e7"],
    [v1, {format: "peerpedia-submission-v5"}, "953fda4447e8356351d99b08c869539a1fb7f969062fb3598b28f2272017ef23"],
    [v2, {primary_category: null}, "d89a29f7a11597c00539d9a968fe7c7c35e329a27797d04595d9d36c0478b75d"],
    [v3, {agreement: {...v3.manifest.agreement, sha256: "g".repeat(64)}}, "ed23af55fb5542f9dbc715ccac0004cf2de90871dc51caeff16163be48c96fc0"],
    [v4, {chapters: [...v4.manifest.chapters].reverse()}, "a5c4d95016ac046079354ded83b289584e8307e3a3f7fa73a6ed40ad8ec94540"],
  ] as const) {
    expect((): unknown => verifySnapshot({...base, manifest: {...base.manifest, ...patch}, snapshot_identifier: null, hash})).toThrow(ProtocolError);
  }
});

test("accepts HTTPS license resources and rejects non-web URL schemes", async (): Promise<void> => {
  for (const url of ["https://creativecommons.org/licenses/by/4.0/", "blob:" + origin + "/opaque", "javascript:void(0)"]) {
    const transport = new Responses([json({licenses: [{code: "policy", label: "Policy", url}]})]);
    const reading = new PeerpediaApi(origin, transport).licenses();
    if (url.startsWith("https://")) expect((await reading)[0].url).toBe(url);
    else await expect(reading).rejects.toThrow(ProtocolError);
  }
});
