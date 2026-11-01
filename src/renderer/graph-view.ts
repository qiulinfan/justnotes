import type { CorePluginHost } from "../api/internal-plugins";
// The graph core plugin's views: the global graph (`graph`) and the local
// graph of the active note (`localgraph`), with Obsidian's controls panel.
import type { App } from "../api/app";
import { setIcon } from "../api/icons";
import { Keymap } from "../api/keymap";
import { getAllTags } from "../api/metadata-utils";
import { isIndexedNote } from "../api/note-files";
import { readInOrder } from "../api/read-in-order";
import { Menu } from "../api/ui/menu";
import { type HoverPopover, PopoverState } from "../api/ui/popover";
import { Setting } from "../api/ui/setting";
import { debounce } from "../api/util";
import { type TAbstractFile, TFile } from "../api/vault";
import { ItemView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";
import {
	buildGraph,
	colorCss,
	colorHex,
	compileQuery,
	DEFAULT_OPTIONS,
	type GraphData,
	type GraphFile,
	type GraphOptions,
	LIMITS,
	localGraph,
	nodeSubject,
	type NodeType,
	type Query,
	readOptions,
} from "./graph-data";
import { GraphRenderer, type RenderNode } from "./graph-renderer";

type Change = "data" | "display" | "forces" | "panel";

abstract class BaseGraphView extends ItemView {
	options: GraphOptions = readOptions(null);
	renderer: GraphRenderer | null = null;
	#controlsEl!: HTMLElement;
	// Note texts for queries that look at contents, dropped when a note changes.
	#texts = new Map<string, string>();
	#generation = 0;
	hoverPopover: HoverPopover | null = null;
	// The node the page preview was last asked for.
	#previewed: string | null = null;
	#update = debounce(() => this.update(), 100, true);
	#saveScale = debounce(() => this.app.workspace.requestSaveLayout(), 500, true);

	abstract readonly local: boolean;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "git-fork";
		this.navigation = false;
	}

	async onOpen() {
		this.contentEl.addClass("graph-view-container");
		this.renderer = new GraphRenderer(this.contentEl, this.options, {
			click: (node, evt) => this.#open(node, evt),
			hover: (node, evt) => this.#hover(node, evt),
			menu: (node, evt) => this.#menu(node, evt),
			zoom: (scale) => {
				this.options.scale = scale;
				this.#saveScale();
			},
		});
		this.#controlsEl = this.contentEl.createDiv("graph-controls");
		this.#buildControls();
		const { metadataCache, vault, workspace } = this.app;
		this.registerEvent(metadataCache.on("resolved", () => this.refresh()));
		this.registerEvent(metadataCache.on("changed", (file: TFile) => this.#dropText(file)));
		this.registerEvent(vault.on("create", () => this.refresh()));
		this.registerEvent(vault.on("delete", (file: TAbstractFile) => this.#dropText(file)));
		this.registerEvent(
			vault.on("rename", (file: TAbstractFile, old: string) => {
				this.#texts.delete(old);
				this.#dropText(file);
			}),
		);
		this.registerEvent(workspace.on("css-change", () => this.renderer?.readTheme()));
		let ignored = JSON.stringify(vault.getConfig("userIgnoreFilters"));
		this.registerEvent(
			vault.on("config-changed", () => {
				const next = JSON.stringify(vault.getConfig("userIgnoreFilters"));
				if (next === ignored) return;
				ignored = next;
				this.refresh();
			}),
		);
		this.refresh();
	}

	async onClose() {
		this.renderer?.destroy();
		this.renderer = null;
	}

	onResize() {
		this.renderer?.reheat(0);
	}

	refresh() {
		this.#update();
	}

	#dropText(file: TAbstractFile) {
		this.#texts.delete(file.path);
		this.refresh();
	}

	// The data the view shows; the local graph narrows the global one.
	abstract graph(global: GraphData): GraphData;

	abstract focused(id: string): boolean;

	async update() {
		if (!this.renderer) return;
		const generation = ++this.#generation;
		const { vault, metadataCache } = this.app;
		const search = compileQuery(this.options.search);
		const groups = this.options.colorGroups.map((g) => ({ query: compileQuery(g.query), color: colorCss(g.color) }));
		const queries = [search, ...groups.map((g) => g.query)].filter((q): q is Query => !!q);
		// Excluded files (userIgnoreFilters) are left out, as in Obsidian.
		const files = vault.getFiles().filter((file) => this.focused(file.path) || !metadataCache.isUserIgnored(file.path));
		if (queries.some((q) => q.needsText)) {
			const unread = files.filter((file) => isIndexedNote(file) && !this.#texts.has(file.path));
			for await (const [file, text] of readInOrder(vault, unread)) {
				if (generation !== this.#generation) return;
				this.#texts.set(file.path, text);
			}
		}
		const subjects = new Map<string, GraphFile & { frontmatter: Record<string, unknown> | null; text: string | null }>();
		for (const file of files) {
			const cache = file.extension === "md" ? metadataCache.getFileCache(file) : null;
			const tags = [...new Set((getAllTags(cache) ?? []).map((t) => t.replace(/^#/, "").toLowerCase()))];
			subjects.set(file.path, { path: file.path, extension: file.extension, tags, frontmatter: cache?.frontmatter ?? null, text: this.#texts.get(file.path) ?? null });
		}
		const global = buildGraph(
			{
				files: [...subjects.values()],
				resolvedLinks: metadataCache.resolvedLinks,
				unresolvedLinks: metadataCache.unresolvedLinks,
				filter: search ? (file) => this.focused(file.path) || search.test(subjects.get(file.path)!) : undefined,
			},
			this.options,
		);
		const data = this.graph(global);
		this.renderer.setData(data, (id, type) => {
			const subject = type === "tag" || type === "unresolved" ? nodeSubject(id, type) : subjects.get(id);
			const color = subject ? (groups.find((g) => g.query?.test(subject))?.color ?? null) : null;
			return { label: label(id, type), color, focused: this.focused(id) };
		});
		this.#showEmpty(!data.nodes.length);
		this.updated();
	}

	// After new data is shown.
	updated() {}

	#showEmpty(empty: boolean) {
		let el = this.contentEl.querySelector<HTMLElement>(".graph-empty");
		if (!empty) return el?.remove();
		el ??= this.contentEl.createDiv({ cls: "graph-empty", text: this.local ? "No file is open, or nothing to show." : "No notes match." });
	}

	async #open(node: RenderNode, evt: MouseEvent) {
		const { workspace, vault } = this.app;
		const where = Keymap.isModEvent(evt);
		if (node.type === "tag") {
			const search = this.app.internalPlugins.getEnabledPluginById("global-search");
			search?.openGlobalSearch?.(`tag:${node.id}`);
			return;
		}
		const file = vault.getFileByPath(node.id);
		if (!file) {
			// An unresolved link opens as Obsidian's links do: creating the note.
			await workspace.openLinkText(node.id, "", where || false);
			return;
		}
		// The local graph opens beside itself; the global graph replaces itself
		// only when asked for a new tab.
		const leaf = where ? workspace.getLeaf(where) : this.#targetLeaf();
		await leaf.openFile(file, { active: true });
	}

	// Page preview of a hovered note or image node, with Mod as for links in
	// the editor (the `graph` hover source). The popover shows at the pointer
	// and goes once the pointer is on neither the node nor the popover.
	#hover(node: RenderNode | null, evt: MouseEvent) {
		const popover = this.hoverPopover;
		if (popover && popover.state !== PopoverState.Hidden && node?.id !== this.#previewed) {
			if (node || popover.state === PopoverState.Showing) popover.hide();
			else
				window.setTimeout(() => {
					if (this.renderer?.hovered?.id !== this.#previewed && !popover.hoverEl.matches(":hover")) popover.hide();
				}, 300);
		}
		if (!node || (node.type !== "file" && node.type !== "attachment")) return;
		this.#previewed = node.id;
		this.app.workspace.trigger("hover-link", { event: evt, source: "graph", hoverParent: this, targetEl: null, linktext: node.id, sourcePath: "" });
	}

	#targetLeaf() {
		const { workspace } = this.app;
		let target: WorkspaceLeaf | null = null;
		const recent = workspace.getMostRecentLeaf();
		if (recent && recent !== this.leaf && recent.view.navigation) target = recent;
		workspace.iterateRootLeaves((l) => {
			if (!target && l !== this.leaf && l.view.navigation) target = l;
		});
		return target ?? workspace.getLeaf("tab");
	}

	#menu(node: RenderNode, evt: MouseEvent) {
		const file = this.app.vault.getAbstractFileByPath(node.id);
		if (!file) return;
		const menu = new Menu();
		menu.addSections(["title", "action-primary", "open", "action", "info", "view", "system", "danger"]);
		if (file instanceof TFile) {
			const open = (title: string, icon: string, where: "tab" | "split") =>
				menu.addItem((i) =>
					i
						.setSection("open")
						.setTitle(title)
						.setIcon(icon)
						.onClick(() => this.app.workspace.getLeaf(where).openFile(file, { active: true })),
				);
			open("Open in new tab", "file-plus", "tab");
			open("Open to the right", "separator-vertical", "split");
		}
		this.app.workspace.trigger("file-menu", menu, file, "graph-context-menu", this.leaf);
		menu.showAtMouseEvent(evt);
	}

	// An option changed in the panel.
	#changed(change: Change) {
		if (change === "data") this.refresh();
		else if (change === "display") this.renderer?.setDisplay(this.options);
		else if (change === "forces") this.renderer?.setForces(this.options);
		this.app.workspace.requestSaveLayout();
	}

	// Options read from graph.json or the view state replace the current ones.
	applyOptions(options: GraphOptions) {
		this.options = options;
		if (this.renderer) {
			this.renderer.setDisplay(options);
			this.renderer.setForces(options);
			const k = this.renderer.transform.k;
			if (Math.abs(k - options.scale) > 1e-9) this.renderer.zoomAt(options.scale / k);
			this.#buildControls();
		}
		this.refresh();
	}

	#buildControls() {
		const el = this.#controlsEl;
		const o = this.options;
		el.empty();
		el.toggleClass("is-close", o.close);
		const button = (cls: string, icon: string, title: string, onClick: () => void) => {
			const b = el.createDiv({ cls: `clickable-icon graph-controls-button ${cls}`, attr: { "aria-label": title } });
			setIcon(b, icon);
			b.addEventListener("click", onClick);
		};
		button("mod-close", "x", "Close", () => {
			o.close = true;
			this.#buildControls();
			this.#changed("panel");
		});
		button("mod-open", "settings", "Open graph settings", () => {
			o.close = false;
			this.#buildControls();
			this.#changed("panel");
		});
		button("mod-reset", "rotate-ccw", "Restore default settings", () => {
			const keep = { close: o.close, scale: o.scale };
			this.applyOptions({ ...readOptions(null, this.defaults()), ...keep });
			this.#changed("data");
		});
		const section = (key: "collapse-filter" | "collapse-color-groups" | "collapse-display" | "collapse-forces", cls: string, title: string) => {
			const item = el.createDiv(`tree-item graph-control-section ${cls}`);
			const self = item.createDiv("tree-item-self mod-collapsible");
			const icon = self.createDiv("tree-item-icon collapse-icon");
			self.createDiv({ cls: "tree-item-inner", text: title });
			const children = item.createDiv("tree-item-children");
			const set = () => {
				item.toggleClass("is-collapsed", o[key]);
				setIcon(icon, o[key] ? "chevron-right" : "chevron-down");
			};
			set();
			self.addEventListener("click", () => {
				o[key] = !o[key];
				set();
				this.#changed("panel");
			});
			return children;
		};
		const toggle = (parent: HTMLElement, name: string, key: "showTags" | "showAttachments" | "hideUnresolved" | "showOrphans" | "showArrow" | "localBacklinks" | "localForelinks" | "localInterlinks", change: Change) =>
			new Setting(parent).setName(name).addToggle((t) =>
				t.setValue(o[key]).onChange((value) => {
					o[key] = value;
					this.#changed(change);
				}),
			);
		const slider = (parent: HTMLElement, name: string, key: keyof typeof LIMITS, change: Change) =>
			new Setting(parent)
				.setName(name)
				.setClass("mod-slider")
				.addSlider((s) => {
					const [min, max, step] = LIMITS[key];
					s.setLimits(min, max, step)
						.setDisplayFormat(() => "")
						.setInstant(true)
						.setValue(o[key])
						.onChange((value) => {
							o[key] = value;
							this.#changed(change);
						});
				});

		const filters = section("collapse-filter", "mod-filter", "Filters");
		new Setting(filters).setClass("mod-search-setting").addSearch((s) => {
			s.setPlaceholder("Search files...")
				.setValue(o.search)
				.onChange((value) => {
					o.search = value;
					this.#changed("data");
				});
		});
		if (this.local) {
			slider(filters, "Depth", "localJumps", "data");
			toggle(filters, "Incoming links", "localBacklinks", "data");
			toggle(filters, "Outgoing links", "localForelinks", "data");
			toggle(filters, "Neighbor links", "localInterlinks", "data");
		}
		toggle(filters, "Tags", "showTags", "data");
		toggle(filters, "Attachments", "showAttachments", "data");
		toggle(filters, "Existing files only", "hideUnresolved", "data");
		toggle(filters, "Orphans", "showOrphans", "data");

		const groups = section("collapse-color-groups", "mod-color-groups", "Groups");
		const list = groups.createDiv("graph-color-groups-container");
		o.colorGroups.forEach((group, index) => {
			new Setting(list)
				.setClass("graph-color-group")
				.addSearch((s) =>
					s
						.setPlaceholder("Enter query...")
						.setValue(group.query)
						.onChange((value) => {
							group.query = value;
							this.#changed("data");
						}),
				)
				.addColorPicker((c) =>
					c.setValue(colorHex(group.color.rgb)).onChange(() => {
						const { r, g, b } = c.getValueRgb();
						group.color = { a: group.color.a, rgb: (r << 16) | (g << 8) | b };
						this.#changed("data");
					}),
				)
				.addExtraButton((b) =>
					b
						.setIcon("x")
						.setTooltip("Delete group")
						.onClick(() => {
							o.colorGroups.splice(index, 1);
							this.#buildControls();
							this.#changed("data");
						}),
				);
		});
		new Setting(groups).setClass("graph-color-button-container").addButton((b) =>
			b
				.setButtonText("New group")
				.setCta()
				.onClick(() => {
					const hue = Math.floor(Math.random() * 360);
					o.colorGroups.push({ query: "", color: { a: 1, rgb: hslToRgb(hue, 0.7, 0.55) } });
					this.#buildControls();
					this.#changed("data");
				}),
		);

		const display = section("collapse-display", "mod-display", "Display");
		toggle(display, "Arrows", "showArrow", "display");
		slider(display, "Text fade threshold", "textFadeMultiplier", "display");
		slider(display, "Node size", "nodeSizeMultiplier", "display");
		slider(display, "Link thickness", "lineSizeMultiplier", "display");

		const forces = section("collapse-forces", "mod-forces", "Forces");
		slider(forces, "Center force", "centerStrength", "forces");
		slider(forces, "Repel force", "repelStrength", "forces");
		slider(forces, "Link force", "linkStrength", "forces");
		slider(forces, "Link distance", "linkDistance", "forces");
	}

	// The options "Restore default settings" goes back to.
	defaults() {
		return DEFAULT_OPTIONS;
	}
}

function hslToRgb(h: number, s: number, l: number) {
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const a = s * Math.min(l, 1 - l);
		return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
	};
	return (f(0) << 16) | (f(8) << 8) | f(4);
}

// What a node is called: a note by its name, an attachment by its file name,
// a tag with its '#', an unresolved link by its text.
export function label(id: string, type: NodeType) {
	if (type === "file") return id.slice(id.lastIndexOf("/") + 1).replace(/\.md$/i, "");
	if (type === "attachment") return id.slice(id.lastIndexOf("/") + 1);
	return id;
}

// Reads <configDir>/graph.json, never writing it: its options seed the global
// graph, and the view state keeps what is changed here.
async function readGraphJson(app: App) {
	try {
		return readOptions(JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/graph.json`)));
	} catch {
		return readOptions(null);
	}
}

export class GraphView extends BaseGraphView {
	readonly local = false;
	#base: GraphOptions = DEFAULT_OPTIONS;
	#state: unknown = null;

	getViewType() {
		return "graph";
	}

	getDisplayText() {
		return "Graph view";
	}

	async onOpen() {
		this.#base = await readGraphJson(this.app);
		this.options = readOptions(this.#state, this.#base);
		await super.onOpen();
	}

	getState() {
		return { options: this.options };
	}

	async setState(state: any) {
		if (!state?.options) return;
		this.#state = state.options;
		this.applyOptions(readOptions(state.options, this.#base));
	}

	defaults() {
		return this.#base;
	}

	focused() {
		return false;
	}

	graph(global: GraphData) {
		return global;
	}
}

export class LocalGraphView extends BaseGraphView {
	readonly local = true;
	file: TFile | null = null;
	#centered: TFile | null = null;

	getViewType() {
		return "localgraph";
	}

	getDisplayText() {
		return this.file ? `Local graph of ${this.file.basename}` : "Local graph";
	}

	async onOpen() {
		// It follows the note in front; focusing the graph itself keeps the note.
		this.registerEvent(
			this.app.workspace.on("file-open", (file: TFile | null) => {
				if (file && file !== this.file) this.#setFile(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file === this.file) this.#setFile(null);
			}),
		);
		this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile) => file === this.file && this.leaf.updateHeader()));
		this.file ??= this.app.workspace.getActiveFile();
		await super.onOpen();
	}

	#setFile(file: TFile | null) {
		this.file = file;
		this.leaf.updateHeader();
		this.app.workspace.requestSaveLayout();
		this.refresh();
	}

	getState() {
		return { file: this.file?.path ?? null, options: this.options };
	}

	async setState(state: any) {
		const file = typeof state?.file === "string" ? this.app.vault.getFileByPath(state.file) : null;
		if (file) this.file = file;
		if (state?.options) this.applyOptions(readOptions(state.options));
		else this.refresh();
		this.leaf.updateHeader();
	}

	focused(id: string) {
		return id === this.file?.path;
	}

	// A new note in the middle moves the layout to it.
	updated() {
		if (!this.file || this.file === this.#centered) return;
		this.#centered = this.file;
		this.renderer?.centerOn(this.file.path);
	}

	graph(global: GraphData) {
		return this.file ? localGraph(global, this.file.path, this.options) : { nodes: [], links: [] };
	}
}

export function registerGraphViews(app: App) {
	app.viewRegistry.registerView("graph", (leaf) => new GraphView(leaf));
	app.viewRegistry.registerView("localgraph", (leaf) => new LocalGraphView(leaf));
}

// The commands and ribbon button, with Obsidian's ids. The global graph
// opens once, in a tab of its own; the local graph opens beside the note.
export function installGraph(app: App, host: CorePluginHost) {
	const { workspace } = app;
	workspace.hoverLinkSources.graph = { display: "Graph view", defaultMod: true };
	host.register(() => delete workspace.hoverLinkSources.graph);
	const openGraph = async () => {
		const existing = workspace.getLeavesOfType("graph")[0];
		if (existing) {
			workspace.setActiveLeaf(existing, { focus: true });
			await workspace.revealLeaf(existing);
			return;
		}
		await workspace.getLeaf("tab").setViewState({ type: "graph", active: true });
	};
	host.addCommand({ id: "graph:open", name: "Graph view: Open graph view", icon: "git-fork", callback: openGraph });
	host.addCommand({
		id: "graph:open-local",
		name: "Graph view: Open local graph",
		icon: "git-fork",
		checkCallback: (checking) => {
			const file = workspace.getActiveFile();
			if (!file) return false;
			if (!checking) void workspace.getLeaf("split").setViewState({ type: "localgraph", state: { file: file.path }, active: true });
			return true;
		},
	});
	host.addRibbonIcon("graph:Open graph view", "git-fork", "Open graph view", openGraph);
	host.register(() => {
		workspace.detachLeavesOfType("graph");
		workspace.detachLeavesOfType("localgraph");
	});
}
