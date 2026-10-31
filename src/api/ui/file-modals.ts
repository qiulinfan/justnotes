import type { App } from "../app";
import { type TAbstractFile, TFolder } from "../vault";
import { Modal } from "./modal";
import { Notice } from "./notice";
import { FuzzySuggestModal } from "./suggest";

// The file dialogs of the explorer, also used by the image menu and other
// panes: a one-line prompt and the folder picker of "Move file to...".

// Runs a file operation, showing its error as a notice.
export async function attempt(action: () => Promise<unknown>) {
	try {
		await action();
	} catch (err) {
		new Notice(err instanceof Error ? err.message : String(err));
	}
}

// Moves items into a folder picked from the vault's folders, except the
// moved folders and the folders inside them.
export class MoveModal extends FuzzySuggestModal<TFolder> {
	#items: TAbstractFile[];

	constructor(app: App, items: TAbstractFile[]) {
		super(app);
		// An item inside a moved folder moves with it.
		const inside = (item: TAbstractFile, folder: TAbstractFile) => folder instanceof TFolder && item.path.startsWith(`${folder.path}/`);
		this.#items = items.filter((item) => !items.some((other) => inside(item, other)));
		this.setPlaceholder("Move to folder...");
	}

	getItems() {
		return this.app.vault.getAllFolders(true).filter((f) => !this.#items.some((item) => f === item || (item instanceof TFolder && f.path.startsWith(`${item.path}/`))));
	}

	getItemText(folder: TFolder) {
		return folder.isRoot() ? "/" : folder.path;
	}

	async onChooseItem(folder: TFolder) {
		for (const item of this.#items) {
			if (item.parent !== folder) await attempt(() => this.app.fileManager.renameFile(item, folder.isRoot() ? item.name : `${folder.path}/${item.name}`));
		}
	}
}

export class PromptModal extends Modal {
	constructor(app: App, title: string, value: string, onSubmit: (value: string) => any) {
		super(app);
		this.setTitle(title);
		const input = this.contentEl.createEl("input", { type: "text", value, cls: "prompt-modal-input" });
		const submit = () => {
			const v = input.value.trim();
			this.close();
			if (v && v !== value) onSubmit(v);
		};
		this.scope.register([], "Enter", () => {
			submit();
			return false;
		});
		this.onOpen = () => {
			input.focus();
			input.select();
		};
	}
}
