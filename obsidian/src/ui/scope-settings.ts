import { Notice, PluginSettingTab, type App } from "obsidian";
import type PeerpediaPlugin from "../main";
import { isRelativePath } from "../project/path-identity";
import { errorMessage } from "./conflict-modal";

export class ScopeSettings extends PluginSettingTab {
  constructor(app: App, private readonly owner: PeerpediaPlugin) { super(app, owner); }

  override display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h3", { text: "BananaMark writing assistance" });
    this.containerEl.createEl("p", { text: "Off by default. Subfolder rules override parent folders. File rules take priority." });
    for (const kind of ["folders", "files"] as const) {
      const folder = kind === "folders";
      this.containerEl.createEl("h4", { text: folder ? "Folder rules" : "File rules" });
      const change = (path: string, enabled: boolean | null): void => {
        const scope = this.owner.writingScope;
        const rules = { ...scope[kind], [path]: enabled ?? false };
        if (enabled === null) delete rules[path];
        void this.owner.updateWritingScope({ ...scope, [kind]: rules })
          .then((): void => this.display()).catch((error: unknown): void => { new Notice(errorMessage(error)); });
      };
      for (const [path, enabled] of Object.entries(this.owner.writingScope[kind])) {
        const row = this.containerEl.createDiv({ cls: "peerpedia-actions" });
        row.createSpan({ text: path || "Vault root" });
        row.createEl("button", { text: enabled ? "Enabled" : "Disabled" }).onclick = (): void => change(path, !enabled);
        row.createEl("button", { text: "Remove rule" }).onclick = (): void => change(path, null);
      }
      const row = this.containerEl.createDiv({ cls: "peerpedia-actions" });
      const input = row.createEl("input", { type: "text", placeholder: folder ? "Folder path (blank for vault root)" : "Markdown file path" });
      const add = (enabled: boolean): void => {
        const path = input.value.trim();
        if (!(folder && !path) && (!isRelativePath(path) || (!folder && !/\.md$/i.test(path)))) {
          new Notice("Enter a valid path within the vault."); return;
        }
        change(path, enabled);
      };
      row.createEl("button", { text: "Enable" }).onclick = (): void => add(true);
      row.createEl("button", { text: "Disable" }).onclick = (): void => add(false);
    }
  }
}
