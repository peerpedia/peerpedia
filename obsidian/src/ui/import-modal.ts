import { Notice, type App } from "obsidian";
import type { ProjectSnapshot } from "../project/types";
import { PeerpediaApi } from "../remote/api";
import { importPaper, type ImportStore } from "../remote/import";
import { parseRemoteLink } from "../remote/links";
import type { Transport } from "../remote/types";
import { PaperForm } from "./paper-form";

export class ImportModal extends PaperForm {
  constructor(app: App, origin: string, transport: Transport, store: ImportStore,
    complete: (project: ProjectSnapshot) => Promise<void>) {
    super(app,"从 Peerpedia 导入论文");
    const site = this.field("站点地址",origin);
    const link = this.field("论文、快照或版本阅读链接");
    const folder = this.field("库内新文件夹（父文件夹须存在）");
    const progress = this.contentEl.createEl("p",{attr:{"aria-live":"polite"}});
    this.submit("导入论文",async (): Promise<void> => {
      const selected = site.value.trim(), root = folder.value.trim(), url = link.value.trim();
      const target = parseRemoteLink(url,selected);
      const live = this.request.begin((): boolean => site.value.trim() === selected && link.value.trim() === url && folder.value.trim() === root);
      progress.setText("正在读取并核对远程版本，关闭窗口可取消。");
      try {
        const project = await importPaper(target,root,new PeerpediaApi(selected,transport),store,live,(): void => {
          site.disabled = link.disabled = folder.disabled = true;
          progress.setText("正在保存论文和绑定。关闭窗口后保存仍会完成。");
        });
        if (live()) await complete(project);
        else new Notice("已导入论文至 " + root);
      } catch (error: unknown) {
        if (!this.contentEl.isConnected && !live()) new Notice(error instanceof Error ? error.message : "导入未完成。");
        throw error;
      } finally {
        progress.empty();
        site.disabled = link.disabled = folder.disabled = false;
      }
    });
  }
}
