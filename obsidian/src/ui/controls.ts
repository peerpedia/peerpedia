import { Menu, setIcon, type Modal, type MenuItem } from "obsidian";

export interface Action {
  title: string;
  icon?: string;
  disabled?: boolean;
  run: () => void;
}

export function styleModal(modal: Modal, wide: boolean = false): void {
  modal.modalEl.addClass("peerpedia-modal");
  if (wide) modal.modalEl.addClass("peerpedia-modal-wide");
  modal.contentEl.addClass("peerpedia-paper-form");
}

export function iconButton(parent: HTMLElement, label: string, icon: string, action: () => void): HTMLButtonElement {
  const node = parent.createEl("button", {cls: "peerpedia-icon-button clickable-icon", attr: {"aria-label": label, title: label}});
  setIcon(node, icon);
  node.onclick = action;
  return node;
}

export function actionMenu(event: MouseEvent, actions: readonly Action[]): void {
  const menu = new Menu();
  for (const action of actions) menu.addItem((item: MenuItem): void => {
    item.setTitle(action.title).setDisabled(Boolean(action.disabled)).onClick(action.run);
    if (action.icon) item.setIcon(action.icon);
  });
  menu.showAtMouseEvent(event);
}

export function menuButton(parent: HTMLElement, label: string, actions: () => readonly Action[]): HTMLButtonElement {
  const node = iconButton(parent,label,"ellipsis",(): void => {});
  node.onclick = (event: MouseEvent): void => actionMenu(event,actions());
  return node;
}
