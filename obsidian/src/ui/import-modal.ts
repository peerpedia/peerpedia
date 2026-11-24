import { errorMessage } from "./conflict-modal";
import { Notice, type App } from "obsidian";
import type { ProjectSnapshot } from "../project/types";
import { PeerpediaApi } from "../remote/api";
import type { ProjectStore } from "../project/store";
import { importPaper } from "../remote/import";
import { parseRemoteLink } from "../remote/links";
import type { Transport } from "../remote/types";
import { PaperForm } from "./paper-form";

export class ImportModal extends PaperForm {
  constructor(app: App, origin: string, transport: Transport, store: ProjectStore,
    complete: (project: ProjectSnapshot) => Promise<void>) {
    super(app,"Import paper from Peerpedia");
    const site = this.field("Site URL",origin);
    const link = this.field("Paper, snapshot, or version reading link");
    const folder = this.field("New folder in the vault (parent folder must exist)");
    const progress = this.contentEl.createEl("p",{attr:{"aria-live":"polite"}});
    this.submit("Import paper",async (): Promise<void> => {
      const selected = site.value.trim(), root = folder.value.trim(), url = link.value.trim();
      const target = parseRemoteLink(url,selected);
      const live = this.request.begin((): boolean => site.value.trim() === selected && link.value.trim() === url && folder.value.trim() === root);
      progress.setText("Reading and verifying the remote version. Close this window to cancel.");
      try {
        const project = await importPaper(target,root,new PeerpediaApi(selected,transport),store,live,(): void => {
          site.disabled = link.disabled = folder.disabled = true;
          progress.setText("Saving the paper and its binding. Saving continues if you close this window.");
        });
        if (live()) await complete(project);
        else new Notice("Paper imported to " + root);
      } catch (error: unknown) {
        if (!this.contentEl.isConnected && !live()) new Notice(errorMessage(error, "Import did not complete."));
        throw error;
      } finally {
        progress.empty();
        site.disabled = link.disabled = folder.disabled = false;
      }
    });
  }
}
