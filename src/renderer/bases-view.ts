// Bases in the app: the view for .base files, ```base blocks, ![[x.base]]
// embeds and the Bases commands.
import type { App } from "../api/app";
import { QueryController } from "../api/bases/controller";
import { renderBaseBlock, renderBaseEmbeds } from "../api/bases/embed";
import { loadPropertyTypes } from "../api/bases/frontmatter";
import { CARDS_VIEW } from "../api/bases/cards-view";
import { LIST_VIEW } from "../api/bases/list-view";
import { TABLE_VIEW } from "../api/bases/table-view";
import { registerBasesViewType } from "../api/bases/view";
import { MarkdownPreviewRenderer } from "../api/markdown";
import type { Menu } from "../api/ui/menu";
import { type TAbstractFile, type TFile, TFolder } from "../api/vault";
import { FileView, TextFileView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";

const NEW_BASE = "views:\n  - type: table\n    name: Table\n    order:\n      - file.name\n";

// A .base file. The YAML is the file's data; toolbar edits change it and are
// saved like any other text file view.
export class BasesFileView extends TextFileView {
	#controller: QueryController | null = null;
	#viewName: string | null = null;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "table";
		this.contentEl.addClass("bases-file-view");
	}

	getViewType() {
		return "bases";
	}

	canAcceptExtension(extension: string) {
		return extension === "base";
	}

	getState() {
		return { ...super.getState(), viewName: this.#controller?.viewName ?? this.#viewName };
	}

	async setState(state: any, result: { history: boolean }) {
		if (typeof state?.viewName === "string") {
			this.#viewName = state.viewName;
			const index = this.#controller?.configs.findIndex((c) => c.name === state.viewName) ?? -1;
			if (index >= 0) this.#controller!.selectView(index);
		}
		await super.setState(state, result);
	}

	async onOpen() {
		// Follow edits made outside this view, as long as nothing here is unsaved.
		this.registerEvent(
			this.app.vault.on("modify", async (f: TAbstractFile) => {
				const file = this.file;
				if (!file || f !== file || this.getViewData() !== this.data) return;
				const text = await this.app.vault.read(file);
				if (text === this.data) return;
				this.data = text;
				this.setViewData(text, false);
			}),
		);
	}

	getViewData() {
		return this.#controller?.source.text ?? this.data;
	}

	setViewData(data: string, clear: boolean) {
		if (this.#controller && !clear) {
			this.#controller.setSource(data);
			return;
		}
		this.clear();
		const view = this;
		this.#controller = this.addChild(
			new QueryController(this.app, this.contentEl.createDiv(), {
				text: data,
				file: this.file,
				get sourcePath() {
					return view.file?.path ?? "";
				},
				thisFile: () => this.#thisFile(),
				viewName: this.#viewName,
				save: () => {
					this.requestSave();
				},
				viewChanged: (name) => {
					this.#viewName = name;
					this.app.workspace.requestSaveLayout();
				},
				followActiveFile: !this.app.workspace.isRootLeaf(this.leaf),
				addMenuItems: (menu) => this.#addMenuItems(menu),
			}),
		);
	}

	clear() {
		if (this.#controller) this.removeChild(this.#controller);
		this.#controller = null;
		this.contentEl.empty();
	}

	// `this` is the base itself, or in a sidebar the file open in the main area.
	#thisFile(): TFile | null {
		if (this.app.workspace.isRootLeaf(this.leaf)) return this.file;
		const view = this.app.workspace.getMostRecentLeaf()?.view;
		return view instanceof FileView ? view.file : null;
	}

	onPaneMenu(menu: Menu, _source: string) {
		this.#addMenuItems(menu);
	}

	#addMenuItems(menu: Menu) {
		menu.addItem((item) => item.setTitle("Open as text").setIcon("file-code").setSection("file").onClick(() => this.#openAsText()));
	}

	async #openAsText() {
		const file = this.file;
		if (!file) return;
		await this.save();
		await this.leaf.setViewState({ type: "markdown", state: { file: file.path }, active: true });
	}
}

async function createBase(app: App, folder?: TFolder) {
	const parent = folder ?? app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
	const dir = parent.isRoot() ? "" : `${parent.path}/`;
	let path = `${dir}Untitled.base`;
	for (let i = 1; app.vault.getAbstractFileByPath(path); i++) path = `${dir}Untitled ${i}.base`;
	const file = await app.vault.create(path, NEW_BASE);
	await app.workspace.getLeaf(false).openFile(file);
}

export function installBases(app: App) {
	registerBasesViewType("table", TABLE_VIEW);
	registerBasesViewType("cards", CARDS_VIEW);
	registerBasesViewType("list", LIST_VIEW);
	app.viewRegistry.registerView("bases", (leaf) => new BasesFileView(leaf));
	app.viewRegistry.registerExtensions(["base"], "bases");
	MarkdownPreviewRenderer.registerCodeBlockPostProcessor("base", (source, el, ctx) => renderBaseBlock(app, source, el, ctx));
	MarkdownPreviewRenderer.registerPostProcessor((el, ctx) => renderBaseEmbeds(app, el, ctx));
	app.workspace.hoverLinkSources.bases = { display: "Bases", defaultMod: true };
	app.commands.addCommand({ id: "bases:new-file", name: "Bases: Create new base", icon: "table", callback: () => createBase(app) });
	app.commands.addCommand({
		id: "bases:insert",
		name: "Bases: Insert new base",
		icon: "table",
		editorCallback: (editor) => editor.replaceSelection(`\`\`\`base\n${NEW_BASE}\`\`\`\n`),
	});
	app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
		if (file instanceof TFolder) menu.addItem((item) => item.setTitle("New base").setIcon("table").setSection("action-primary").onClick(() => createBase(app, file)));
	});
	loadPropertyTypes(app);
}
