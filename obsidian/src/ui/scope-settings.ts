import { Notice, PluginSettingTab, Setting, type App, type ToggleComponent, type ExtraButtonComponent } from "obsidian";
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
        new Setting(this.containerEl).setName(path || "Vault root")
          .addToggle((toggle: ToggleComponent): void => {
            toggle.setValue(enabled).setTooltip("Enable BananaMark assistance").onChange((value: boolean): void => change(path,value));
          }).addExtraButton((remove: ExtraButtonComponent): void => {
            remove.setIcon("x").setTooltip("Remove rule").onClick((): void => change(path,null));
          });
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
      const enabled = row.createEl("select", {attr:{"aria-label":"Rule behavior"}});
      enabled.createEl("option",{text:"Enable assistance",value:"true"});
      enabled.createEl("option",{text:"Disable assistance",value:"false"});
      row.createEl("button", { text: "Add rule" }).onclick = (): void => add(enabled.value==="true");
    }
  }
}
