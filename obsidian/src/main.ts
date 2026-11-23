import { Plugin } from "obsidian";

import { createSourceExtension } from "./host/editor-extension";

export default class PeerpediaPlugin extends Plugin {
  override onload(): void {
    this.registerEditorExtension(createSourceExtension((path: string): boolean => {
      const fileStart = path.lastIndexOf("/") + 1;
      return path.slice(fileStart) === "paper.md"
        && this.app.vault.getFileByPath(`${path.slice(0, fileStart)}paper.json`) !== null;
    }));
  }
}
