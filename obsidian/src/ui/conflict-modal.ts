import { Modal, Notice, type App } from "obsidian";
import { styleModal } from "./controls";
import { userErrorMessage } from "../user-error";
import type { RecoveryNotice } from "../project/recovery";
import { ProjectReadError } from "../project/types";

export async function openLocalFile(path: string, reveal: boolean): Promise<void> {
  const { shell } = await import("electron");
  if (reveal) { shell.showItemInFolder(path); return; }
  const error = await shell.openPath(path);
  if (error) throw new Error(error);
}

export function errorMessage(error: unknown, fallback: string = "The operation could not be completed."): string {
  if (error instanceof ProjectReadError) return `Unable to read "${error.issue.path}". ${error.issue.message} Check the source file.`;
  return userErrorMessage(error, fallback);
}

export class ConflictModal extends Modal {
  constructor(app: App, private readonly error: unknown, private readonly records: readonly RecoveryNotice[],
    private readonly reveal: (record: RecoveryNotice) => Promise<void>) { super(app); }

  override onOpen(): void {
    styleModal(this,true);
    this.setTitle("Review file changes");
    this.contentEl.createEl("p", { text: errorMessage(this.error) });
    for (const record of this.records) {
      this.contentEl.createEl("p", { text: record.message });
      this.contentEl.createEl("p", { text: record.paths.join(", ") });
      this.contentEl.createEl("button", { text: "View recovery files" }).onclick = (): void => {
        void this.reveal(record).catch((error: unknown): void => { new Notice(errorMessage(error)); });
      };
    }
    this.contentEl.createEl("button", { text: "Back" }).onclick = (): void => this.close();
  }
}
