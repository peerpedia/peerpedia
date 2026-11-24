import { UserFacingError } from "../user-error";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import type { RenderPage, RenderRequest, RenderResponse } from "../../renderer/protocol";
import type { VaultProjectStore } from "../host/vault-store";
import type { ProjectSnapshot } from "../project/types";
import { PeerpediaApi } from "./api";
import { checkAccount, defaultIntent, prepareSubmission, publication, type AppendHead, type PreparedSubmission, type SubmissionDetails, type SubmissionIntent } from "./submit";
import type { AccountIdentity, AccountInfo, Category, CredentialStore, LicenseOption, RemoteBinding, Transport, VerifiedSnapshot } from "./types";

import type { BindingVersion } from "./binding";
import type { PrHead, RemoteCheck } from "./types";

interface CheckStore {
  readBindingVersion(root: string): Promise<BindingVersion>;
  saveBinding(root: string, binding: RemoteBinding, expectedDigest: string | null): Promise<void>;
}

export async function checkRemote(binding: RemoteBinding, api: PeerpediaApi, proposalId: string|undefined = binding.activePr?.id ?? binding.proposalSource?.id): Promise<RemoteCheck> {
  if (api.origin !== binding.origin) throw new UserFacingError("The selected site does not match the paper binding.");
  const current = await api.current(binding.paperId);
  const heads = await api.prs(binding.paperId);
  const activePr = proposalId
    ? heads.find((head: PrHead): boolean => head.id === proposalId)
    : heads.find((head: PrHead): boolean => head.submissionId === (binding.lastSubmitted ?? binding.workingBase).submissionId
      && head.hash === (binding.lastSubmitted ?? binding.workingBase).hash);
  if (proposalId && !activePr) throw new UserFacingError("The linked proposal is currently unavailable. Try checking again later.");
  return {current,activePr:activePr ?? null,checkedAt:new Date().toISOString()};
}

export async function checkProject(root: string, api: PeerpediaApi, store: CheckStore, displayedDigest?: string): Promise<RemoteCheck> {
  const {binding,digest} = await store.readBindingVersion(root);
  if (!binding || (displayedDigest !== undefined && displayedDigest !== digest)) throw new UserFacingError("The paper binding changed. Reopen the paper.");
  const observation = await checkRemote(binding,api);
  await store.saveBinding(root,{...binding,checkedAt:observation.checkedAt},digest);
  return observation;
}

export interface Catalog { categories:readonly Category[]; licenses:readonly LicenseOption[] }
export interface SubmitContext {
  identity:AccountIdentity; account:AccountInfo; binding:RemoteBinding|null; digest:string|null; intent:SubmissionIntent; catalog:Catalog; proposalHead:VerifiedSnapshot|null; predecessor:AppendHead|null; changedHead:boolean;
}
export interface SubmissionReview {context:SubmitContext; project:ProjectSnapshot; request:PreparedSubmission; pages:readonly RenderPage[]}
type Validate = (request:RenderRequest,signal:AbortSignal)=>Promise<RenderResponse>;

export class SubmissionController {
  private readonly catalogs = new Map<string,Catalog>();
  constructor(private readonly store:VaultProjectStore, private readonly identity:()=>AccountIdentity|null, private readonly credentials:CredentialStore,
    private readonly transport:Transport, private readonly render:Validate) {}

  catalog(origin:string): Catalog|undefined { return this.catalogs.get(origin); }

  private async token(origin:string,username:string): Promise<string> {
    const active = this.identity();
    if (active?.origin !== origin || active.username !== username) throw new UserFacingError("Connect the original site and account first.");
    const value = await this.credentials.read(origin,username);
    if (!value) throw new UserFacingError("Connect your account and verify its access token first.");
    return value;
  }

  async open(root:string, intent?:SubmissionIntent): Promise<SubmitContext> {
    const version = await this.store.readBindingVersion(root);
    if (version.pendingSubmission || version.pendingMerge || version.pendingImport) throw new UserFacingError("Complete the pending project operation first.");
    const identity = this.identity();
    if (!identity || (version.binding && version.binding.origin !== identity.origin)) throw new UserFacingError("Connect an account on this paper’s site first.");
    const api = new PeerpediaApi(identity.origin,this.transport);
    const account = await api.me(await this.token(identity.origin,identity.username));
    checkAccount(account,identity.username,version.binding ? "new-pr" : "publish");
    let binding = version.binding;
    let proposalHead:VerifiedSnapshot|null = null;
    let predecessor:AppendHead|null = null;
    let changedHead = false;
    if (binding) {
      const source = binding.workingBase;
      let prId = binding.activePr?.id ?? binding.proposalSource?.id;
      if (intent !== "new-pr" && !prId && source.status !== "accepted") {
        const exact = await api.proposalSnapshot(source.submissionId);
        if (exact.snapshot.hash !== source.hash) throw new UserFacingError("The working snapshot differs from the site’s record.");
        prId = exact.proposal?.id;
      }
      const check = intent === "new-pr" ? {current:await api.current(binding.paperId),activePr:null} : await checkRemote(binding,api,prId);
      if (check.current.hash !== binding.acceptedBase.hash || (source.hash !== check.current.hash && source.manifest.base_hash !== check.current.hash))
        throw new UserFacingError("Compare and confirm the current accepted version first.");
      const head = check.activePr;
      const owned = head?.status === "pending" && head.owner === identity.username;
      const incorporated = binding.activePr ?? source;
      changedHead = !!owned && (head.hash !== incorporated.hash || head.submissionId !== incorporated.submissionId);
      if (intent === "append-pr" && (!owned || changedHead)) throw new UserFacingError("Compare and confirm the open proposal before appending.");
      if (owned && !changedHead && intent !== "new-pr") {
        const exact = await api.proposalSnapshot(head.submissionId);
        if (exact.proposal?.id !== head.id || exact.snapshot.hash !== head.hash || exact.snapshot.paperId !== binding.paperId
          || exact.snapshot.status !== "pending" || exact.snapshot.manifest.contributor_name !== identity.username) throw new UserFacingError("The proposal head changed. Review it again.");
        proposalHead = exact.snapshot;
        predecessor = {id:head.id,submissionId:head.submissionId,hash:head.hash,number:exact.proposal.number};
      }
      binding = {...binding,activePr:head};
    }
    let catalog = this.catalogs.get(api.origin);
    if (!catalog) {
      const [categories,licenses] = await Promise.all([api.categories(),api.licenses()]);
      catalog = {categories,licenses};
      this.catalogs.set(api.origin,catalog);
    }
    return {identity,account,binding,digest:version.digest,intent:changedHead ? "new-pr" : defaultIntent(binding,identity.username),catalog,proposalHead,predecessor,changedHead};
  }

  async review(root:string, intent:SubmissionIntent, details:SubmissionDetails, signal:AbortSignal): Promise<SubmissionReview> {
    const context = await this.open(root,intent);
    const project = await this.store.read(root);
    const doc = publication(project);
    const codes = [doc.primary_category,...doc.secondary_categories];
    if (new Set(codes).size !== codes.length || !codes.every((code:string):boolean => context.catalog.categories.some((c:Category):boolean => c.id===code)))
      throw new UserFacingError("Choose valid, distinct subject categories in the paper metadata.");
    if (!context.catalog.licenses.some((license:LicenseOption):boolean => license.code===doc.license))
      throw new UserFacingError("Choose a valid content license in the paper metadata.");
    const id = randomUUID();
    const result = await this.render({id,revision:project.revision,document:doc},signal);
    if (signal.aborted || result.id !== id || result.revision !== project.revision) throw new UserFacingError("The renderer returned a different revision. Preview the manuscript again.");
    if ("error" in result) throw new UserFacingError([result.error.file,result.error.line,result.error.message].filter(Boolean).join(" "));
    const expectedPages = doc.chapters.length ? doc.chapters : [{id:"main",title:null}];
    if (result.pages.length !== expectedPages.length || !result.pages.every((page:RenderPage,index:number):boolean =>
      page.id === expectedPages[index].id && (expectedPages[index].title === null || page.title === expectedPages[index].title) && typeof page.html === "string"))
      throw new UserFacingError("Rendered pages differ from the manuscript. Review the chapter IDs and headings.");
    const request = prepareSubmission(project,context.binding,context.account,intent,details,context.identity.origin);
    return {context,project,request,pages:result.pages};
  }

  async confirm(review:SubmissionReview, live:()=>boolean): Promise<VerifiedSnapshot> {
    const {request,project,context} = review;
    const now = await this.open(project.root,request.intent);
    if (!equal(now.identity,context.identity) || now.digest !== context.digest
      || (request.intent === "append-pr" && !equal(now.predecessor,context.predecessor)))
      throw new UserFacingError("The site, account or version changed. Preview it again before confirming.");
    const token = await this.token(request.origin,request.username);
    await this.store.submissions.persistRequest(project.root,request,context.digest,live,context.predecessor);
    return this.store.submissions.sendPrepared(project.root,request,token,this.transport);
  }

  async retry(root:string,displayed:PreparedSubmission): Promise<VerifiedSnapshot> {
    const request = await this.store.submissions.pending(root);
    if (!equal(request,displayed) || !request) throw new UserFacingError("The pending submission changed. Reopen it.");
    const token = await this.token(request.origin,request.username);
    return this.store.submissions.sendPrepared(root,request,token,this.transport);
  }
}
