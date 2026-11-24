import { isDeepStrictEqual as equal } from "node:util";
import type { PublicationDocument } from "../project/publication";
import { Modal, type App } from "obsidian";
import type { VaultProjectStore } from "../host/vault-store";
import type { SubmissionController, SubmissionReview, SubmitContext } from "../remote/controller";
import { frozenPayload, type PreparedSubmission, type SubmissionDetails, type SubmissionIntent } from "../remote/submit";
import type { Category, LicenseOption, VerifiedSnapshot } from "../remote/types";
import { articleFragment } from "../preview/article";
import { button } from "./paper-form";

const labels:Record<SubmissionIntent,string> = {publish:"Publish a new paper", "append-pr":"Add a snapshot to the open proposal", "new-pr":"Create a new proposal"};
function showRequest(box:HTMLElement, request:PreparedSubmission): void {
  const doc = frozenPayload(request);
  box.createEl("h3",{text:doc.title});
  for (const [label,value] of [["Authors",doc.authors],["Abstract",doc.abstract],["Subjects",[doc.primary_category,...doc.secondary_categories].join(", ")],
    ["License",doc.license],["Explanation",doc.explanation],["AI assistance",doc.ai_assisted ? "Yes" : "No"]]) box.createEl("p",{text:label+" · "+value});
  for (const chapter of doc.chapters) {
    box.createEl("h4",{text:chapter.title+" ("+chapter.id+")"});
    box.createEl("pre",{text:chapter.markdown});
  }
  if (!doc.chapters.length) box.createEl("pre",{text:doc.markdown});
  if (doc.bibliography) { box.createEl("h4",{text:"Bibliography"}); box.createEl("pre",{text:doc.bibliography}); }
  box.createEl("p",{text:request.origin+" · "+request.username+" · "+labels[request.intent]});
  if (doc.expected_head) box.createEl("p",{text:"Current proposal snapshot · "+doc.expected_head});
  box.createEl("p",{text:request.intent === "publish" ? "Confirming will publish this paper publicly." : "Confirming will create a public proposal snapshot for consideration."});
}

function changes(box:HTMLElement, previous:PublicationDocument, current:PublicationDocument):void {
  const section = box.createEl("details");
  section.createEl("summary",{text:"Changes from the previous version"});
  const fields = ["title","authors","abstract","primary_category","secondary_categories","license","chapters","markdown","bibliography"] as const;
  let changed = false;
  for (const key of fields) {
    if ((key === "markdown" && previous.chapters.length && current.chapters.length) || equal(previous[key],current[key])) continue;
    changed = true;
    const field = section.createEl("details");
    field.createEl("summary",{text:key.replaceAll("_"," ")});
    for (const [label,doc] of [["Before",previous],["After",current]] as const) {
      field.createEl("strong",{text:label});
      const value = doc[key];
      field.createEl("pre",{text:typeof value === "string" ? value : JSON.stringify(value,null,2)});
    }
  }
  if (!changed) section.createEl("p",{text:"The manuscript matches the previous version."});
}

export class SubmitModal extends Modal {
  private readonly abort = new AbortController();
  private details:SubmissionDetails = {explanation:"",aiAssisted:false};
  constructor(app:App, private readonly root:string, private readonly store:VaultProjectStore, private readonly controller:SubmissionController,
    private readonly updated:()=>Promise<void>) { super(app); this.setTitle("Submit to Peerpedia"); this.contentEl.addClass("peerpedia-paper-form"); }

  override onOpen(): void { this.run(():Promise<void> => this.openForm()); }
  override onClose(): void { this.abort.abort(); }
  private run(action:()=>Promise<void>): void {
    void action().catch((error:unknown):void => {
      if (this.abort.signal.aborted) return;
      this.contentEl.createEl("p",{text:error instanceof Error ? error.message : "Submission failed.",attr:{role:"alert"}});
      button(this.contentEl,"Review again",():void => {this.run(():Promise<void> => this.openForm());});
    });
  }
  private async openForm(): Promise<void> {
    this.contentEl.setText("Loading submission details…");
    const pending = await this.store.submissions.pending(this.root);
    if (this.abort.signal.aborted) return;
    if (pending) {
      const saved = await this.store.submissions.hasReceipt(this.root,pending);
      if (!this.abort.signal.aborted) this.confirmation(pending,undefined,saved);
      return;
    }
    const context = await this.controller.open(this.root);
    if (!this.abort.signal.aborted) this.fields(context);
  }
  private fields(context:SubmitContext): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p",{text:context.identity.origin+" · "+context.identity.username});
    const mode = el.createEl("label",{text:"Submission type "}).createEl("select");
    mode.createEl("option",{text:labels[context.intent],value:context.intent});
    if (context.intent === "append-pr") mode.createEl("option",{text:labels["new-pr"],value:"new-pr"});
    const lookup = el.createEl("details");
    lookup.createEl("summary",{text:"Available subjects and licenses"});
    lookup.createEl("p",{text:context.catalog.licenses.map((v:LicenseOption):string => v.code+" · "+v.label).join("\n")});
    lookup.createEl("p",{text:context.catalog.categories.map((v:Category):string => v.id+" · "+v.name).join("\n")});
    const explanation = el.createEl("label",{text:"Explanation "}).createEl("textarea");
    explanation.value = this.details.explanation;
    const ai = el.createEl("label",{text:"AI assisted "}).createEl("input",{type:"checkbox"});
    ai.checked = this.details.aiAssisted;
    button(el,"Preview submission",():void => {
      this.details = {explanation:explanation.value,aiAssisted:ai.checked};
      this.run(():Promise<void> => this.preview(mode.value as SubmissionIntent));
    });
  }
  private async preview(intent:SubmissionIntent): Promise<void> {
    this.contentEl.setText("Validating and rendering the manuscript…");
    const review = await this.controller.review(this.root,intent,this.details,this.abort.signal);
    if (!this.abort.signal.aborted) this.confirmation(review.request,review);
  }
  private confirmation(request:PreparedSubmission,review?:SubmissionReview,saved:boolean=false): void {
    const box = this.contentEl;
    box.empty();
    if (saved) box.createEl("p",{text:"A verified site receipt is saved. Finish updating the local binding offline."});
    else if (!review) box.createEl("p",{text:"The previous submission is awaiting confirmation. Retry sends the saved content below with the original request ID."});
    showRequest(box,request);
    if (review) {
      const article = box.createEl("details");
      article.createEl("summary",{text:"Rendered manuscript"});
      for (const page of review.pages) article.createEl("article").appendChild(articleFragment(box.ownerDocument,page.html));
    }
    if (review?.context.binding) {
      const prior = request.intent === "append-pr" ? review.context.proposalHead! : review.context.binding.acceptedBase;
      changes(box,prior.document,frozenPayload(request));
    }
    button(box,review ? "Confirm submission" : saved ? "Finish from saved receipt" : "Retry saved submission",():void => this.run(async ():Promise<void> => {
      box.setText("Checking the submission result…");
      if (review && (await this.store.read(this.root)).revision !== request.sourceRevision) {
        await this.preview(request.intent);
        if (!this.abort.signal.aborted) box.prepend(box.createEl("p",{text:"The manuscript changed. Review the new preview and confirm again."}));
        return;
      }
      try {
        const snapshot = review ? await this.controller.confirm(review,():boolean => !this.abort.signal.aborted)
          : saved ? await this.store.submissions.recoverReceipt(this.root,request) : await this.controller.retry(this.root,request);
        if (!this.abort.signal.aborted) this.result(request.origin,snapshot);
      } catch (error:unknown) {
        if (!review || this.abort.signal.aborted || await this.store.submissions.pending(this.root)
          || (await this.store.read(this.root)).revision === request.sourceRevision) throw error;
        await this.preview(request.intent);
        if (!this.abort.signal.aborted) box.prepend(box.createEl("p",{text:"The manuscript changed. Review the new preview and confirm again."}));
      } finally { await this.updated(); }
    }));
    if (review) button(box,"Edit submission details",():void => this.fields(review.context));
  }
  private result(origin:string,snapshot:VerifiedSnapshot): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p",{text:"The site confirmed your submission. Snapshot status · "+snapshot.status});
    const link = el.createEl("a",{text:"View public snapshot",href:origin+"/submissions/"+(snapshot.publicId ?? snapshot.submissionId)+"/"});
    link.target = "_blank"; link.rel = "noopener noreferrer";
  }
}
