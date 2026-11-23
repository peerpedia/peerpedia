import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Modal, Notice, type App } from "obsidian";
import type { RecoveryNotice } from "../project/recovery";
import { ProjectReadError } from "../project/types";

const open = promisify(execFile);
export async function openLocalFile(path: string, reveal: boolean): Promise<void> {
  await open("/usr/bin/open", [reveal ? "-R" : "-t", path]);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ProjectReadError) return `无法读取「${error.issue.path}」。${error.issue.message} 请打开原文件检查。`;
  if (error instanceof Error && /[\u3400-\u9fff]/.test(error.message)) return error.message;
  return "操作未完成。请检查文件名称、文件夹位置及读写权限。";
}

export class ConflictModal extends Modal {
  constructor(app: App, private readonly error: unknown, private readonly records: readonly RecoveryNotice[],
    private readonly reveal: (record: RecoveryNotice) => Promise<void>) { super(app); }

  override onOpen(): void {
    this.setTitle("核对文件更改");
    this.contentEl.createEl("p", { text: errorMessage(this.error) });
    for (const record of this.records) {
      this.contentEl.createEl("p", { text: record.message });
      this.contentEl.createEl("p", { text: record.paths.join("、") });
      this.contentEl.createEl("button", { text: "查看恢复文件" }).onclick = (): void => {
        void this.reveal(record).catch((error: unknown): void => { new Notice(errorMessage(error)); });
      };
    }
    this.contentEl.createEl("button", { text: "返回" }).onclick = (): void => this.close();
  }
}
