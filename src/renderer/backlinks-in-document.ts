import type { App } from "../api/app";
import { Component } from "../api/events";
import { type EmbeddedBacklinks, MarkdownView } from "../api/markdown-view";
import { debounce } from "../api/util";
import type { TFile } from "../api/vault";
import { BacklinkList } from "./link-panes";

// The backlinks under a note (backlink.json's backlinkInDocument), rendered
// as the backlinks pane renders them. The view places `containerEl` under
// the editor's last line or in the reading view's footer.
class BacklinksInDocument extends Component implements EmbeddedBacklinks {
	containerEl = createDiv("embedded-backlinks");
	#view: MarkdownView;
	#list: BacklinkList;
	#file: TFile | null = null;
	#generation = 0;
	#refresh = debounce(() => this.#render(), 300, true);

	constructor(view: MarkdownView) {
		super();
		this.#view = view;
		this.#list = new BacklinkList(view.app, () => this.#refresh());
	}

	onload() {
		const { metadataCache, vault } = this.#view.app;
		this.registerEvent(metadataCache.on("resolve", (file: TFile) => this.#list.affectedBy(file, this.#view.file) && this.#refresh()));
		this.registerEvent(vault.on("rename", () => this.#refresh()));
		this.registerEvent(vault.on("delete", () => this.#refresh()));
		this.#render();
	}

	onunload() {
		this.#refresh.cancel();
		this.#generation++;
	}

	update() {
		if (this.#view.file !== this.#file) this.#render();
	}

	async #render() {
		const generation = ++this.#generation;
		const file = this.#view.file;
		this.#file = file;
		const el = createDiv("backlink-pane link-pane");
		el.createDiv({ cls: "embedded-backlinks-title", text: "Backlinks" });
		if (file) await this.#list.fill(file, el, () => generation === this.#generation);
		if (generation !== this.#generation) return;
		this.containerEl.empty();
		this.containerEl.append(el);
	}
}

// The backlink core plugin's part of a note's view, and its command.
export function installBacklinksInDocument(app: App) {
	const instance = app.internalPlugins.getEnabledPluginById("backlink");
	if (!instance) return;
	instance.createEmbeddedBacklinks = (view: MarkdownView) => new BacklinksInDocument(view);
	app.commands.addCommand({
		id: "backlink:toggle-backlinks",
		name: "Backlinks: Toggle backlinks in document",
		checkCallback: (checking: boolean) => {
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return false;
			if (!checking) view.toggleBacklinks();
			return true;
		},
	});
}
