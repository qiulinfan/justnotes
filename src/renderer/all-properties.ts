// The core plugin `properties`: the All properties pane (view type
// "all-properties"), every property name in the vault with its type and the
// number of notes that have it. A property unfolds to its notes; its menu
// changes its type or renames it in every note.
import type { App } from "../api/app";
import { locateFrontmatter, renameProperty } from "../api/frontmatter-edit";
import { setIcon, setTooltip } from "../api/icons";
import { Keymap } from "../api/keymap";
import { Menu } from "../api/ui/menu";
import { Notice } from "../api/ui/notice";
import { debounce } from "../api/util";
import type { TFile } from "../api/vault";
import { ItemView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";
import { PromptModal } from "./views";

export const ALL_PROPERTIES_VIEW = "all-properties";

// The notes whose frontmatter has the property, by its exact name.
function notesWith(app: App, name: string): TFile[] {
	const files: TFile[] = [];
	for (const path of app.metadataCache.getCachedFiles()) {
		const fm = app.metadataCache.getCache(path)?.frontmatter;
		const file = fm && Object.hasOwn(fm, name) ? app.vault.getFileByPath(path) : null;
		if (file) files.push(file);
	}
	return files.sort((a, b) => a.path.localeCompare(b.path));
}

// Renames a property in every note that has it, each note's frontmatter
// rewritten only at that key. A note that already has the new name keeps
// both. The old name's assigned type goes to the new one.
export async function renamePropertyEverywhere(app: App, from: string, to: string) {
	const files = new Set<TFile>();
	for (const path of app.metadataCache.getCachedFiles()) {
		const fm = app.metadataCache.getCache(path)?.frontmatter;
		const file = fm ? app.vault.getFileByPath(path) : null;
		if (file && Object.keys(fm!).some((k) => k.toLowerCase() === from.toLowerCase())) files.add(file);
	}
	let renamed = 0;
	for (const file of files) {
		await app.vault.process(file, (text) => {
			const fm = locateFrontmatter(text);
			if (!fm) return text;
			const yaml = text.slice(fm.yamlFrom, fm.yamlTo);
			const key = Object.keys(app.metadataCache.getFileCache(file)?.frontmatter ?? {}).find((k) => k.toLowerCase() === from.toLowerCase()) ?? from;
			const next = renameProperty(yaml, key, to);
			if (next !== yaml) renamed++;
			return text.slice(0, fm.yamlFrom) + next + text.slice(fm.yamlTo);
		});
	}
	const types = app.metadataTypeManager;
	const type = types.getAssignedType(from);
	if (type && !types.getAssignedType(to)) types.setType(to, type);
	return renamed;
}

export class AllPropertiesView extends ItemView {
	#byCount = false;
	#open = new Set<string>();
	#refresh = debounce(() => this.render(), 300, true);

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.navigation = false;
	}

	getViewType() {
		return ALL_PROPERTIES_VIEW;
	}

	getDisplayText() {
		return "All properties";
	}

	getIcon() {
		return "lucide-archive";
	}

	getState(): Record<string, any> {
		return { ...super.getState(), sortOrder: this.#byCount ? "frequency" : "alphabetical" };
	}

	async setState(state: any, result: any) {
		await super.setState(state, result);
		this.#byCount = state?.sortOrder === "frequency";
		this.render();
	}

	async onOpen() {
		this.contentEl.addClass("all-properties-view");
		this.addAction("arrow-up-narrow-wide", "Change sort order", () => {
			this.#byCount = !this.#byCount;
			this.render();
			this.app.workspace.requestSaveLayout();
		});
		this.registerEvent(this.app.metadataTypeManager.on("changed", () => this.render()));
		this.registerEvent(this.app.metadataCache.on("changed", () => this.#refresh()));
		this.registerEvent(this.app.metadataCache.on("deleted", () => this.#refresh()));
		this.register(() => this.#refresh.cancel());
		this.render();
	}

	render() {
		const types = this.app.metadataTypeManager;
		types.updatePropertyInfoCache();
		const infos = Object.values(types.getAllProperties()).sort((a, b) =>
			this.#byCount ? b.count - a.count || a.name.localeCompare(b.name) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
		const scroll = this.contentEl.scrollTop;
		this.contentEl.empty();
		if (!infos.length) {
			this.contentEl.createDiv({ cls: "pane-empty", text: "No properties found." });
			return;
		}
		const list = this.contentEl.createDiv("all-properties-list");
		for (const info of infos) {
			const item = list.createDiv("tree-item");
			const self = item.createDiv({ cls: "tree-item-self is-clickable", attr: { "data-property-key": info.name, tabindex: 0 } });
			const widget = types.getWidget(info.type);
			const icon = self.createDiv("tree-item-icon");
			setIcon(icon, widget.icon);
			setTooltip(icon, widget.name());
			self.createDiv({ cls: "tree-item-inner", text: info.name });
			self.createDiv("tree-item-flair-outer").createSpan({ cls: "tree-item-flair", text: String(info.count) });
			const key = info.name.toLowerCase();
			const toggle = () => {
				if (this.#open.has(key)) this.#open.delete(key);
				else this.#open.add(key);
				this.render();
			};
			self.addEventListener("click", toggle);
			self.addEventListener("keydown", (evt) => {
				if (evt.key !== "Enter") return;
				evt.preventDefault();
				toggle();
			});
			self.addEventListener("contextmenu", (evt) => {
				evt.preventDefault();
				this.#menu(info.name, info.type).showAtMouseEvent(evt);
			});
			if (!this.#open.has(key)) continue;
			const children = item.createDiv("tree-item-children");
			for (const file of notesWith(this.app, info.name)) {
				const note = children.createDiv({ cls: "tree-item-self is-clickable", attr: { "data-path": file.path } });
				note.createDiv({ cls: "tree-item-inner", text: file.basename });
				note.addEventListener("click", (evt) => this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file));
			}
		}
		this.contentEl.scrollTop = scroll;
	}

	#menu(name: string, current: string) {
		const types = this.app.metadataTypeManager;
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle("Property type").setIcon(types.getWidget(current).icon);
			const sub = item.setSubmenu();
			for (const widget of types.getTypesFor(name)) {
				sub.addItem((i) =>
					i
						.setTitle(widget.name())
						.setIcon(widget.icon)
						.setChecked(widget.type === current)
						.onClick(() => types.setType(name, widget.type)),
				);
			}
		});
		menu.addItem((item) =>
			item
				.setTitle("Rename...")
				.setIcon("pencil")
				.onClick(() =>
					new PromptModal(this.app, `Rename property "${name}"`, name, async (to) => {
						const count = await renamePropertyEverywhere(this.app, name, to);
						new Notice(`Renamed "${name}" to "${to}" in ${count} ${count === 1 ? "note" : "notes"}`);
					}).open(),
				),
		);
		return menu;
	}
}

export function registerAllPropertiesView(app: App) {
	app.viewRegistry.registerView(ALL_PROPERTIES_VIEW, (leaf) => new AllPropertiesView(leaf));
}
