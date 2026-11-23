import { Notice, PluginSettingTab, type App } from "obsidian";
import type PeerpediaPlugin from "../main";
import { isRelativePath } from "../project/path-identity";
import { errorMessage } from "./conflict-modal";

export class ScopeSettings extends PluginSettingTab {
  constructor(app: App, private readonly owner: PeerpediaPlugin) { super(app, owner); }

  override display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h3", { text: "BananaMark 写作范围" });
    this.containerEl.createEl("p", { text: "默认关闭。子文件夹可以覆盖父文件夹，单文件设置优先。" });
    for (const kind of ["folders", "files"] as const) {
      const folder = kind === "folders";
      this.containerEl.createEl("h4", { text: folder ? "文件夹规则" : "单文件规则" });
      const change = (path: string, enabled: boolean | null): void => {
        const scope = this.owner.writingScope;
        const rules = { ...scope[kind], [path]: enabled ?? false };
        if (enabled === null) delete rules[path];
        void this.owner.updateWritingScope({ ...scope, [kind]: rules })
          .then((): void => this.display()).catch((error: unknown): void => { new Notice(errorMessage(error)); });
      };
      for (const [path, enabled] of Object.entries(this.owner.writingScope[kind])) {
        const row = this.containerEl.createDiv({ cls: "peerpedia-actions" });
        row.createSpan({ text: path || "库根目录" });
        row.createEl("button", { text: enabled ? "已启用" : "已关闭" }).onclick = (): void => change(path, !enabled);
        row.createEl("button", { text: "移除规则" }).onclick = (): void => change(path, null);
      }
      const row = this.containerEl.createDiv({ cls: "peerpedia-actions" });
      const input = row.createEl("input", { type: "text", placeholder: folder ? "文件夹路径（库根留空）" : "Markdown 文件路径" });
      const add = (enabled: boolean): void => {
        const path = input.value.trim();
        if (!(folder && !path) && (!isRelativePath(path) || (!folder && !/\.md$/i.test(path)))) {
          new Notice("请输入有效的库内路径。"); return;
        }
        change(path, enabled);
      };
      row.createEl("button", { text: "启用" }).onclick = (): void => add(true);
      row.createEl("button", { text: "关闭" }).onclick = (): void => add(false);
    }
  }
}
