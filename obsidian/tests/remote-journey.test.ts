import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vault } from "obsidian";
import { afterAll, beforeAll, expect, test } from "vitest";
import { VaultProjectStore } from "../src/host/vault-store";
import { newPaper, configChange } from "../src/project/management";
import { toPublicationDocument } from "../src/project/publication";
import { renderRequest } from "../renderer/render-request";
import { renderDocument } from "../../packages/peerpedia-renderer/node.mjs";
import type { RenderService } from "../src/preview/browser-renderer-client";
import type { RenderRequest, RenderResponse } from "../renderer/protocol";
import { PeerpediaApi } from "../src/remote/api";
import { importPaper } from "../src/remote/import";
import { checkProject, SubmissionController } from "../src/remote/controller";
import { HostCredentials } from "../src/remote/host-credentials";
import { Secrets } from "./fixtures/secrets";
import { applyMerge, planMergedFiles, prepareMerge, resolveMerge } from "../src/remote/merge";
import type { SubmissionIntent } from "../src/remote/submit";
import { NodeTransport } from "../src/remote/transport";
import type { AccountIdentity, HttpResponse, Transport, VerifiedSnapshot } from "../src/remote/types";
import { startDjangoServer, startFixtureServer, type JourneySite } from "./fixtures/test-server";

let work: string;
// Protocol integration exercises the production handler; browser lifecycle and
// offline engine delivery are verified separately in the real-host journeys.
const renderer: RenderService = {
  render(request: RenderRequest, _signal: AbortSignal): Promise<RenderResponse> {
    return renderRequest(request, renderDocument);
  },
};
const mac = process.platform === "darwin" && process.arch === "arm64";
const django = process.env.PEERPEDIA_TEST_DJANGO === "1";

beforeAll(async (): Promise<void> => {
  if (!mac) return;
  work = await mkdtemp(join(tmpdir(), "peerpedia-journey-"));
}, 120_000);
afterAll(async (): Promise<void> => {
  if (work) await rm(work, {recursive: true, force: true});
});

async function journey(site: JourneySite, dropResponse: boolean): Promise<void> {
  const vault = await mkdtemp(join(work, "vault-"));
  const root = "论文 📝";
  const events = {} as Pick<Vault, "on" | "offref">;
  let store = new VaultProjectStore(vault, events);
  const credentials = new HostCredentials(new Secrets(), {}, async (): Promise<void> => {});
  const identity = {origin: site.origin, username: site.username};
  await credentials.write(site.origin, site.username, site.token);
  const wire = new NodeTransport(site.origin);
  const statuses: number[] = [];
  const posts: {key: string; body: string}[] = [];
  let calls = 0;
  let permitted = false;
  const transport: Transport = {async request(origin: string, route: string, method: "GET" | "POST",
    headers: Readonly<Record<string, string>>, body: Uint8Array | null): Promise<HttpResponse> {
    calls++;
    expect(permitted, "network outside an explicit site action").toBe(true);
    expect(origin).toBe(site.origin);
    if (method === "POST") posts.push({key: headers["Idempotency-Key"], body: Buffer.from(body!).toString("utf8")});
    const response = await wire.request(origin, route, method, headers, body);
    if (method === "POST") statuses.push(response.status);
    return response;
  }};
  async function manual<T>(action: () => Promise<T>): Promise<T> {
    permitted = true;
    try { return await action(); } finally { permitted = false; }
  }
  const api = new PeerpediaApi(site.origin, transport);
  function controller(): SubmissionController {
    return new SubmissionController(store, (): AccountIdentity => identity, credentials, transport, renderer.render.bind(renderer));
  }
  let submit = controller();
  const signal = new AbortController().signal;
  async function submitEdit(intent: SubmissionIntent, explanation: string): Promise<VerifiedSnapshot> {
    const context = await manual((): ReturnType<typeof submit.open> => submit.open(root));
    expect(context.intent).toBe(intent);
    const review = await manual((): ReturnType<typeof submit.review> => submit.review(root, intent,
      {explanation, aiAssisted: false}, signal));
    expect(review.pages).toHaveLength(2);
    expect(review.pages[0].html).toContain("katex");
    return manual((): ReturnType<typeof submit.confirm> => submit.confirm(review, (): boolean => true));
  }

  const project = await store.create(root, newPaper("  新论文 🧪  ", true));
  const proof = {id: "proof", title: "Proof", file: "chapters/proof.md"};
  const metadata = {...project.config, authors: "A. Author", abstract: "Integration fixture.",
    primary_category: "math.AG", license: "CC-BY-4.0", chapters: [...project.config.chapters!, proof]};
  await store.apply(root, project.revision, [configChange(project, metadata),
    {path: proof.file, beforeDigest: null, afterText: "# Proof\n\nSecond chapter.\n"}]);
  const introPath = join(vault, root, "chapters/intro.md");
  const proofPath = join(vault, root, proof.file);
  await appendFile(introPath, "\n外部编辑 Café 😀 and $x^2$.\n");
  const offline = await store.read(root);
  const preview = await renderer.render({id: "offline", revision: offline.revision, document: toPublicationDocument(offline)}, signal);
  expect(preview).toMatchObject({pages: [{html: expect.stringContaining("外部编辑")}, {title: "Proof"}]});
  expect(calls).toBe(0);

  const first = await submitEdit("publish", "  Initial publication.  ");
  expect(first).toMatchObject({status: "accepted", document: {title: "新论文 🧪", license: metadata.license},
    manifest: {format: "peerpedia-submission-v4", base_hash: null, explanation: "Initial publication."}});
  expect(first.publicId).toMatch(/^\d{6}\.[a-f0-9]+$/u);
  let quiet = calls;
  await appendFile(proofPath, "\nProposed revision.\n");
  expect(await store.loadBinding(root)).toMatchObject({acceptedBase: {hash: first.hash}});
  expect(calls).toBe(quiet);
  const proposal = await submitEdit("new-pr", "Add a proof.");
  const prId = (await store.loadBinding(root))!.activePr!.id;
  quiet = calls;
  await appendFile(proofPath, "\nAdditional lemma.\n");
  expect(calls).toBe(quiet);
  let appended: VerifiedSnapshot;
  if (dropResponse) {
    site.loseNextResponse!();
    await expect(submitEdit("append-pr", "Clarify lemma.")).rejects.toThrow();
    quiet = calls;
    await appendFile(introPath, "\nLocal change after uncertain delivery.\n");
    store = new VaultProjectStore(vault, events);
    submit = controller();
    const pending = await store.submissions.pending(root);
    expect(pending?.intent).toBe("append-pr");
    expect(calls).toBe(quiet);
    appended = await manual((): ReturnType<typeof submit.retry> => submit.retry(root, pending!));
    expect(posts.at(-1)).toEqual(posts.at(-2));
    expect(posts.at(-1)!.key).toMatch(/^[a-f0-9-]{36}$/u);
  } else {
    appended = await submitEdit("append-pr", "Clarify lemma.");
  }
  expect(appended.hash).not.toBe(proposal.hash);
  expect((await manual((): ReturnType<typeof api.proposalSnapshot> => api.proposalSnapshot(appended.submissionId))).proposal)
    .toEqual({id: prId, number: 2});
  const historical = await manual((): ReturnType<typeof importPaper> => importPaper(
    {kind:"snapshot",identifier:proposal.submissionId}, "historical", api, store));
  const version = await store.readBindingVersion(historical.root);
  expect(version.binding).toMatchObject({workingBase:{hash:proposal.hash},activePr:null,
    proposalSource:{id:prId,number:1,snapshot:{hash:proposal.hash}}});
  const observed = await manual((): ReturnType<typeof checkProject> => checkProject(historical.root,api,store));
  expect(observed.activePr).toMatchObject({id:prId,submissionId:appended.submissionId,hash:appended.hash,status:"pending"});
  const beforeLegacy = await store.readBindingVersion(historical.root);
  const legacy = {...beforeLegacy.binding!};
  delete legacy.proposalSource;
  await store.saveBinding(historical.root,legacy,beforeLegacy.digest);
  const legacyCheck = await manual((): ReturnType<typeof checkProject> => checkProject(historical.root,api,store));
  expect(legacyCheck.activePr).toEqual(observed.activePr);
  expect(await store.loadBinding(historical.root)).toEqual({...legacy,checkedAt:legacyCheck.checkedAt});
  quiet = calls;
  await site.accept(appended.submissionId);
  await appendFile(proofPath, "\nUnsubmitted after acceptance.\n");
  const retained = await readFile(proofPath, "utf8");
  expect(await store.loadBinding(root)).toMatchObject({acceptedBase: {hash: first.hash}, lastSubmitted: {hash: appended.hash}});
  expect(calls).toBe(quiet);
  const check = await manual((): ReturnType<typeof checkProject> => checkProject(root, api, store));
  expect(check).toMatchObject({current: {hash: appended.hash, status: "accepted"}, activePr: {id: prId, status: "accepted"}});
  const closed = await manual((): ReturnType<typeof checkProject> => checkProject(historical.root,api,store));
  expect(closed.activePr).toMatchObject({id:prId,status:"accepted",hash:appended.hash});
  const draft = await store.read(root);
  const comparison = await manual((): ReturnType<typeof prepareMerge> => prepareMerge(draft, "accepted", store, api));
  quiet = calls;
  expect(comparison.result.conflicts).toEqual([]);
  const changes = planMergedFiles(draft, resolveMerge(comparison.result, {}));
  expect(calls).toBe(quiet);
  await manual((): ReturnType<typeof applyMerge> => applyMerge(draft, changes, comparison.check, store, api));
  expect(await readFile(proofPath, "utf8")).toBe(retained);
  expect(await store.loadBinding(root)).toMatchObject({workingBase: {hash: appended.hash}, acceptedBase: {hash: appended.hash}});
  const next = await submitEdit("new-pr", "Submit later local work.");
  expect(next.manifest.base_hash).toBe(appended.hash);
  expect(next.document.chapters[1].markdown).toBe(retained);
  if (dropResponse) expect(next.document.markdown).toContain("Local change after uncertain delivery.");
  expect((await store.loadBinding(root))!.activePr!.id).not.toBe(prId);
  expect(statuses).toEqual(dropResponse ? [201, 201, 200, 201] : [201, 201, 201, 201]);
  // Independently exercise the real service's error responses and replay rules.
  await expect(manual((): ReturnType<typeof api.me> => api.me("expired-fixture-token"))).rejects.toMatchObject({status: 401});
  await expect(manual((): ReturnType<typeof api.current> => api.current(randomUUID()))).rejects.toMatchObject({status: 404});
  const saved = posts.at(-1)!;
  const attempt = (key: string, body: string): Promise<HttpResponse> => manual((): Promise<HttpResponse> =>
    transport.request(site.origin, "/api/v1/push/", "POST", {"Idempotency-Key": key, "Content-Type": "application/json",
      Authorization: "Bearer " + site.token}, Buffer.from(body)));
  expect((await attempt(saved.key, saved.body)).status).toBe(200);
  const stale = JSON.stringify({...JSON.parse(saved.body), base_hash: first.hash});
  for (const [key, code] of [[saved.key, "idempotency_conflict"], [randomUUID(), "stale_base"]]) {
    const response = await attempt(key, stale);
    expect(response.status).toBe(409);
    expect(JSON.parse(Buffer.from(response.body).toString("utf8"))).toMatchObject({error: {code}});
  }
  expect(await site.counts()).toEqual({papers: 1, snapshots: 4, proposals: 2});
}

test.skipIf(!mac || django)("fault server: publish, lose the append response, restart, retry, accept, merge and submit", async (): Promise<void> => {
  const site = await startFixtureServer();
  try { await journey(site, true); } finally { await site.close(); }
}, 120_000);
test.skipIf(!mac || !django)("isolated Django API: publish, append, accept, merge, resubmit and verify protocol errors", async (): Promise<void> => {
  const site = await startDjangoServer();
  try { await journey(site, false); } finally { await site.close(); }
}, 120_000);
