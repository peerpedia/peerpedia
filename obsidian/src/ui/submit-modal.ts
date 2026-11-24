import { isDeepStrictEqual as equal } from "node:util";
import type { PublicationDocument } from "../project/publication";
import { Modal, type App } from "obsidian";
import type { VaultProjectStore } from "../host/vault-store";
import type { SubmissionController, SubmissionReview, SubmitContext } from "../remote/controller";
import { frozenPayload, type PreparedSubmission, type SubmissionDetails, type SubmissionIntent } from "../remote/submit";
import type { Category, LicenseOption, VerifiedSnapshot } from "../remote/types";
import { PreviewReader, readTheme } from "../preview/reader";
import type { RenderPage } from "../../renderer/protocol";
import { errorMessage } from "./conflict-modal";
import { styleModal } from "./controls";
import { button } from "./paper-form";

const labels:Record<SubmissionIntent,string> = {publish:"Publish a new paper", "append-pr":"Add a snapshot to the open proposal", "new-pr":"Create a new proposal"};
function showChapters(box:HTMLElement, chapters:PublicationDocument["chapters"]): void {
  for (const [index, chapter] of chapters.entries()) {
    box.createEl("h4",{text:(index + 1) + ". " + chapter.title});
    box.createEl("pre",{text:chapter.markdown});
    const identifier = box.createEl("details");
    identifier.createEl("summary",{text:"Chapter identifier"});
    identifier.createEl("code",{text:chapter.id});
  }
}

function showRequest(box:HTMLElement, request:PreparedSubmission, proposalHead?:VerifiedSnapshot|null): void {
  const doc = frozenPayload(request);
  box.createEl("h3",{text:doc.title});
  const metadata=box.createEl("details");
  metadata.createEl("summary",{text:"Paper details and disclosure"});
  for (const [label,value] of [["Authors",doc.authors],["Abstract",doc.abstract],["Subjects",[doc.primary_category,...doc.secondary_categories].join(", ")],
    ["License",doc.license],["Explanation",doc.explanation],["AI assistance",doc.ai_assisted ? "Yes" : "No"]]) metadata.createEl("p",{text:label+" · "+value});
  const source=box.createEl("details");
  source.createEl("summary",{text:"Exact source to submit"});
  showChapters(source,doc.chapters);
  if (!doc.chapters.length) source.createEl("pre",{text:doc.markdown});
  if (doc.bibliography) { source.createEl("h4",{text:"Bibliography"}); source.createEl("pre",{text:doc.bibliography}); }
  box.createEl("p",{text:request.origin+" · "+request.username+" · "+labels[request.intent]});
  if (doc.pull_request_id && doc.expected_head) {
    const proposal = box.createEl("a",{text:"Open proposal on Peerpedia",href:request.origin+"/prs/"+doc.pull_request_id+"/"});
    proposal.target = "_blank";
    proposal.rel = "noopener noreferrer";
    box.createEl("p",{text:"Current proposal snapshot · "+(proposalHead?.publicId ?? doc.expected_head.slice(0,12))});
  }
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
      if (key === "chapters") {
        if (doc.chapters.length) showChapters(field,doc.chapters);
        else field.createEl("p",{text:"Single-file manuscript"});
      } else {
        const value = doc[key];
        field.createEl("pre",{text:typeof value === "string" ? value : value.join(", ") || "(none)"});
      }
    }
  }
  if (!changed) section.createEl("p",{text:"The manuscript matches the previous version."});
}

export class SubmitModal extends Modal {
  private readonly abort = new AbortController();
  private details:SubmissionDetails = {explanation:"",aiAssisted:false};
  constructor(app:App, private readonly root:string, private readonly store:VaultProjectStore, private readonly controller:SubmissionController,
    private readonly updated:()=>Promise<void>) { super(app); this.setTitle("Publish a version"); styleModal(this,true); }

  override onOpen(): void { this.run(():Promise<void> => this.openForm()); }
  override onClose(): void { this.abort.abort(); }
  private run(action:()=>Promise<void>): void {
    void action().catch((error:unknown):void => {
      if (this.abort.signal.aborted) return;
      this.contentEl.createEl("p",{text:errorMessage(error, "Submission failed."),attr:{role:"alert"}});
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
    const proposal = context.binding?.activePr;
    if (context.changedHead) el.createEl("p",{text:"The open proposal has changed. Compare it before appending, or create an independent proposal."});
    else if (proposal && proposal.status !== "pending") el.createEl("p",{text:"The linked proposal is " + proposal.status + ". You can create a new proposal."});
    else if (proposal && proposal.owner !== context.identity.username) el.createEl("p",{text:"The open proposal belongs to " + proposal.owner + ". You can create your own proposal."});
    const mode = el.createEl("label",{text:"Submission type "}).createEl("select");
    if (context.changedHead) {
      const choose = mode.createEl("option",{text:"Choose a submission type",value:""});
      choose.disabled = true;
      choose.selected = true;
    }
    mode.createEl("option",{text:labels[context.intent],value:context.intent});
    if (context.intent === "append-pr") mode.createEl("option",{text:labels["new-pr"],value:"new-pr"});
    const lookup = el.createEl("details");
    lookup.createEl("summary",{text:"Available subjects and licenses"});
    lookup.createEl("p",{text:context.catalog.licenses.map((v:LicenseOption):string => v.code+" · "+v.label).join("\n")});
    lookup.createEl("p",{text:context.catalog.categories.map((v:Category):string => v.id+" · "+v.name).join("\n")});
    const explanation = el.createEl("label",{text:context.binding ? "Explanation (required) " : "Explanation "}).createEl("textarea");
    explanation.value = this.details.explanation;
    const ai = el.createEl("label",{text:"AI assisted "}).createEl("input",{type:"checkbox"});
    ai.checked = this.details.aiAssisted;
    const footer = el.createDiv({cls:"peerpedia-form-footer"});
    button(footer,"Cancel",(): void => this.close()).addClass("peerpedia-quiet");
    const preview = button(footer,"Review submission",():void => {
      this.details = {explanation:explanation.value,aiAssisted:ai.checked};
      this.run(():Promise<void> => this.preview(mode.value as SubmissionIntent));
    });
    preview.addClass("mod-cta");
    preview.disabled = !mode.value;
    mode.onchange = ():void => { preview.disabled = !mode.value; };
  }
  private async preview(intent:SubmissionIntent): Promise<void> {
    this.contentEl.setText("Validating and rendering the manuscript…");
    const review = await this.controller.review(this.root,intent,this.details,this.abort.signal);
    if (!this.abort.signal.aborted) this.confirmation(review.request,review);
  }
  private async manuscript(box:HTMLElement, pages:readonly RenderPage[]): Promise<void> {
    const unavailable = (): void => { box.createEl("p",{text:"Unable to load local preview styles or fonts.",attr:{role:"alert"}}); };
    try {
      const {theme,css} = readTheme();
      if (!box.isConnected || this.abort.signal.aborted) return;
      const chapters = pages.length > 1 ? box.createEl("select",{attr:{"aria-label":"Manuscript chapter"}}) : null;
      for (const page of pages) chapters?.createEl("option",{value:page.id,text:page.title});
      const frame = box.createEl("iframe",{cls:"peerpedia-submission-reader",attr:{title:"Reviewed manuscript"}});
      const reader = new PreviewReader(frame,theme,css,():void => {},unavailable);
      reader.show(pages[0]);
      if (chapters) chapters.onchange = (): void => reader.show(pages[chapters.selectedIndex]);
    } catch { unavailable(); }
  }
  private confirmation(request:PreparedSubmission,review?:SubmissionReview,saved:boolean=false): void {
    const box = this.contentEl;
    box.empty();
    if (saved) box.createEl("p",{text:"A verified site receipt is saved. Finish updating the local binding offline."});
    else if (!review) box.createEl("p",{text:"The previous submission is awaiting confirmation. Retry sends the saved content below with the original request ID."});
    showRequest(box,request,review?.context.proposalHead);
    if (review) {
      box.createEl("p",{text:request.intent === "publish" ? "Confirming will publish this paper publicly." : "Confirming will create a public proposal snapshot for consideration."});
      const article = box.createEl("details");
      article.open = true;
      article.createEl("summary",{text:"Rendered manuscript"});
      void this.manuscript(article,review.pages);
    }
    if (review?.context.binding) {
      const prior = request.intent === "append-pr" ? review.context.proposalHead! : review.context.binding.acceptedBase;
      changes(box,prior.document,frozenPayload(request));
    }
    const footer = box.createDiv({cls:"peerpedia-form-footer"});
    const confirm = button(footer,review ? "Confirm submission" : saved ? "Finish from saved receipt" : "Retry saved submission",():void => this.run(async ():Promise<void> => {
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
    confirm.addClass("mod-cta");
    if (review) button(footer,"Edit submission details",():void => this.fields(review.context));
  }
  private result(origin:string,snapshot:VerifiedSnapshot): void {
    const el = this.contentEl;
    el.empty();
    el.createEl("p",{text:"The site confirmed your submission. Snapshot status · "+snapshot.status});
    const link = el.createEl("a",{text:"View public snapshot",href:origin+"/submissions/"+(snapshot.publicId ?? snapshot.submissionId)+"/"});
    link.target = "_blank"; link.rel = "noopener noreferrer";
  }
}
