import { Modal, type App } from "obsidian";
import { errorMessage } from "./conflict-modal";
import { styleModal } from "./controls";
import { FormRequest } from "./form-request";

export function button(parent: HTMLElement, text: string, action: () => void): HTMLButtonElement {
  const node = parent.createEl("button", { text, cls: "peerpedia-button" });
  node.onclick = action;
  return node;
}

export class PaperForm extends Modal {
  readonly request = new FormRequest();
  override onClose(): void { this.request.cancel(); }

  constructor(app: App, title: string) { super(app); this.setTitle(title); styleModal(this); }

  field(label: string, initial: string = "", multiline: boolean = false): HTMLInputElement | HTMLTextAreaElement {
    const wrapper = this.contentEl.createEl("label");
    wrapper.createSpan({ text: label });
    const input = multiline ? wrapper.createEl("textarea") : wrapper.createEl("input", { type: "text" });
    input.value = initial;
    return input;
  }

  submit(label: string, action: () => Promise<void>): void {
    const status = this.contentEl.createEl("p", { attr: { role: "alert" } });
    const footer = this.contentEl.createDiv({cls: "peerpedia-form-footer"});
    button(footer, "Cancel", (): void => this.close()).addClass("peerpedia-quiet");
    const save = button(footer, label, (): void => {
      save.disabled = true;
      status.empty();
      void action().then((): void => this.close()).catch((error: unknown): void => {
        status.setText(errorMessage(error)); save.disabled = false;
      });
    });
    save.addClass("mod-cta");
  }
}
