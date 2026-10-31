import type { Extension } from "@codemirror/state";
import type { App } from "./app";
import { Events } from "./events";
import { setIcon, setTooltip } from "./icons";
import { Keymap } from "./keymap";
import { Menu } from "./ui/menu";
import type { EditorSuggest } from "./ui/suggest";
import { parseLinktext } from "./metadata-utils";
import { debounce } from "./util";
import { TFile } from "./vault";
import { FileView, type View, type ViewState } from "./view";

let leafCounter = 0;

export abstract class WorkspaceItem extends Events {
	app: App;
	containerEl: HTMLElement;
	parent: WorkspaceParent | null = null;

	constructor(app: App, containerEl: HTMLElement) {
		super();
		this.app = app;
		this.containerEl = containerEl;
	}

	getRoot(): WorkspaceItem {
		let item: WorkspaceItem = this;
		while (item.parent) item = item.parent;
		return item;
	}

	getContainer() {
		return this.getRoot();
	}
}

export abstract class WorkspaceParent extends WorkspaceItem {
	children: WorkspaceItem[] = [];
}

export class WorkspaceLeaf extends WorkspaceItem {
	id = `leaf-${++leafCounter}`;
	view: View;
	tabHeaderEl: HTMLElement;
	tabHeaderInnerIconEl: HTMLElement;
	tabHeaderInnerTitleEl: HTMLElement;
	declare parent: WorkspaceTabs | null;
	pinned = false;
	isDeferred = false;
	history = { backHistory: [] as ViewState[], forwardHistory: [] as ViewState[] };

	constructor(app: App) {
		super(app, createDiv("workspace-leaf"));
		this.tabHeaderEl = createDiv("workspace-tab-header");
		const inner = this.tabHeaderEl.createDiv("workspace-tab-header-inner");
		this.tabHeaderInnerIconEl = inner.createDiv("workspace-tab-header-inner-icon");
		this.tabHeaderInnerTitleEl = inner.createDiv("workspace-tab-header-inner-title");
		const close = inner.createDiv("workspace-tab-header-inner-close-button");
		setIcon(close, "x");
		close.addEventListener("click", (evt) => {
			evt.stopPropagation();
			this.detach();
		});
		this.tabHeaderEl.addEventListener("mousedown", (evt) => {
			if (evt.button === 1) {
				evt.preventDefault();
				this.detach();
			}
		});
		this.tabHeaderEl.addEventListener("click", () => this.app.workspace.setActiveLeaf(this, { focus: true }));
		this.tabHeaderEl.addEventListener("contextmenu", (evt) => {
			const menu = new Menu();
			menu.addItem((i) => i.setTitle("Close").setIcon("x").onClick(() => this.detach()));
			this.view.onPaneMenu(menu, "tab-header");
			this.app.workspace.trigger("leaf-menu", menu, this);
			menu.showAtMouseEvent(evt);
		});
		this.containerEl.addEventListener("mousedown", () => this.app.workspace.setActiveLeaf(this), true);
		this.view = this.app.workspace.createView(this, "empty");
		this.containerEl.appendChild(this.view.containerEl);
		this.view.open(this.containerEl);
		this.updateHeader();
	}

	async open(view: View) {
		const old = this.view;
		this.containerEl.empty();
		if (old) await old.close();
		this.view = view;
		this.containerEl.appendChild(view.containerEl);
		await view.open(this.containerEl);
		this.updateHeader();
		return view;
	}

	async setViewState(state: ViewState, _eState?: any) {
		if (state.pinned !== undefined) this.setPinned(state.pinned);
		if (this.view.getViewType() !== state.type) {
			const view = this.app.workspace.createView(this, state.type);
			await this.open(view);
		}
		await this.view.setState(state.state ?? {}, { history: false });
		this.updateHeader();
		if (state.active) this.app.workspace.setActiveLeaf(this, { focus: true });
		this.app.workspace.onLeafStateChange(this);
	}

	getViewState(): ViewState {
		return { type: this.view.getViewType(), state: this.view.getState(), pinned: this.pinned };
	}

	async openFile(file: TFile, openState?: { active?: boolean; state?: any; eState?: any }) {
		const type = this.app.viewRegistry.getTypeByExtension(file.extension) ?? "markdown";
		await this.setViewState({ type, state: { ...openState?.state, file: file.path }, active: openState?.active ?? true });
		if (openState?.eState) this.view.setEphemeralState(openState.eState);
	}

	getEphemeralState() {
		return this.view.getEphemeralState();
	}

	setEphemeralState(state: any) {
		this.view.setEphemeralState(state);
	}

	getDisplayText() {
		return this.view.getDisplayText();
	}

	getIcon() {
		return this.view.getIcon();
	}

	updateHeader() {
		setIcon(this.tabHeaderInnerIconEl, this.view.getIcon());
		this.tabHeaderInnerTitleEl.setText(this.view.getDisplayText());
		setTooltip(this.tabHeaderEl, this.view.getDisplayText());
	}

	setPinned(pinned: boolean) {
		this.pinned = pinned;
		this.tabHeaderEl.toggleClass("is-pinned", pinned);
		this.trigger("pinned-change", pinned);
	}

	togglePinned() {
		this.setPinned(!this.pinned);
	}

	setGroup(_group: string) {}

	async loadIfDeferred() {}

	onResize() {
		this.view.onResize();
	}

	detach() {
		const parent = this.parent;
		this.view.close();
		this.containerEl.detach();
		this.tabHeaderEl.detach();
		parent?.removeLeaf(this);
		this.app.workspace.onLeafDetached(this);
	}
}

// A tab group: tab headers plus one visible leaf.
export class WorkspaceTabs extends WorkspaceParent {
	declare children: WorkspaceLeaf[];
	headerEl: HTMLElement;
	tabHeaderContainerEl: HTMLElement;
	tabsContainerEl: HTMLElement;
	currentTab = 0;

	constructor(app: App) {
		super(app, createDiv("workspace-tabs"));
		this.headerEl = this.containerEl.createDiv("workspace-tab-header-container");
		this.tabHeaderContainerEl = this.headerEl.createDiv("workspace-tab-header-container-inner");
		this.tabsContainerEl = this.containerEl.createDiv("workspace-tab-container");
	}

	insertChild(index: number, leaf: WorkspaceLeaf) {
		leaf.parent = this;
		this.children.splice(index, 0, leaf);
		this.tabHeaderContainerEl.insertBefore(leaf.tabHeaderEl, this.tabHeaderContainerEl.children[index] ?? null);
		this.tabsContainerEl.appendChild(leaf.containerEl);
		this.selectTab(leaf);
	}

	selectTab(leaf: WorkspaceLeaf) {
		this.currentTab = Math.max(0, this.children.indexOf(leaf));
		for (const c of this.children) {
			const on = c === leaf;
			c.tabHeaderEl.toggleClass("is-active", on);
			c.containerEl.toggle(on);
		}
		leaf.onResize();
	}

	removeLeaf(leaf: WorkspaceLeaf) {
		const i = this.children.indexOf(leaf);
		this.children.remove(leaf);
		leaf.parent = null;
		const next = this.children[Math.min(i, this.children.length - 1)];
		if (next) this.selectTab(next);
		else this.onEmpty();
	}

	onEmpty: () => void = () => {};
}

export class WorkspaceSplit extends WorkspaceParent {
	direction: "vertical" | "horizontal";

	constructor(app: App, direction: "vertical" | "horizontal", cls: string) {
		super(app, createDiv(`workspace-split mod-${direction} ${cls}`));
		this.direction = direction;
	}

	addChild(child: WorkspaceItem, index = this.children.length) {
		child.parent = this;
		this.children.splice(index, 0, child);
		this.containerEl.insertBefore(child.containerEl, this.containerEl.children[index] ?? null);
	}

	removeChild(child: WorkspaceItem) {
		this.children.remove(child);
		child.containerEl.detach();
		child.parent = null;
	}
}

export class WorkspaceSidedock extends WorkspaceSplit {
	collapsed = false;
	tabs: WorkspaceTabs;
	side: "left" | "right";

	constructor(app: App, side: "left" | "right") {
		super(app, "vertical", `mod-${side}-split mod-sidedock`);
		this.side = side;
		this.tabs = new WorkspaceTabs(app);
		this.addChild(this.tabs);
	}

	toggle() {
		this.collapsed ? this.expand() : this.collapse();
	}

	collapse() {
		this.collapsed = true;
		this.containerEl.addClass("is-collapsed");
		this.app.workspace.trigger("layout-change");
	}

	expand() {
		this.collapsed = false;
		this.containerEl.removeClass("is-collapsed");
		this.app.workspace.trigger("layout-change");
	}
}

export class WorkspaceRibbon {
	containerEl: HTMLElement;
	actionsEl: HTMLElement;

	constructor() {
		this.containerEl = createDiv("workspace-ribbon side-dock-ribbon mod-left");
		this.actionsEl = this.containerEl.createDiv("side-dock-actions");
	}

	addRibbonItemButton(id: string, icon: string, title: string, callback: (evt: MouseEvent) => any) {
		const el = this.actionsEl.createDiv({ cls: "clickable-icon side-dock-ribbon-action", attr: { "data-id": id } });
		setIcon(el, icon);
		setTooltip(el, title, { placement: "right" });
		el.addEventListener("click", callback);
		return el;
	}
}

// Obsidian's internal manager that offers each editor suggest a chance to open.
export class EditorSuggestManager {
	suggests: EditorSuggest<any>[] = [];
	currentSuggest: EditorSuggest<any> | null = null;

	addSuggest(s: EditorSuggest<any>) {
		this.suggests.push(s);
	}

	removeSuggest(s: EditorSuggest<any>) {
		this.suggests.remove(s);
		if (this.currentSuggest === s) this.close();
	}

	async trigger(editor: any, file: any, openIfClosed = false) {
		for (const s of this.suggests) {
			if (await s.trigger(editor, file, openIfClosed)) {
				if (this.currentSuggest && this.currentSuggest !== s) this.currentSuggest.close();
				this.currentSuggest = s;
				return;
			}
		}
		this.close();
	}

	close() {
		this.currentSuggest?.close();
		this.currentSuggest = null;
	}

	isShowingSuggestion() {
		return !!this.currentSuggest?.isOpen;
	}
}

export type PaneType = "tab" | "split" | "window";

export class Workspace extends Events {
	app: App;
	containerEl: HTMLElement;
	leftRibbon: WorkspaceRibbon;
	leftSplit: WorkspaceSidedock;
	rightSplit: WorkspaceSidedock;
	rootSplit: WorkspaceSplit;
	activeLeaf: WorkspaceLeaf | null = null;
	layoutReady = false;
	editorSuggest = new EditorSuggestManager();
	hoverLinkSources: Record<string, any> = {};
	editorExtensions: Extension[] = [];
	#layoutReadyCallbacks: (() => any)[] = [];
	#recentRootLeaves: WorkspaceLeaf[] = [];
	#lastActiveFile: TFile | null = null;
	#lastOpenFiles: string[] = [];

	constructor(app: App) {
		super();
		this.app = app;
		this.containerEl = createDiv("workspace");
		this.leftRibbon = new WorkspaceRibbon();
		this.leftSplit = new WorkspaceSidedock(app, "left");
		this.rootSplit = new WorkspaceSplit(app, "vertical", "mod-root");
		this.rightSplit = new WorkspaceSidedock(app, "right");
		this.containerEl.append(this.leftRibbon.containerEl, this.leftSplit.containerEl, this.rootSplit.containerEl, this.rightSplit.containerEl);
		this.#newRootTabs();
		window.addEventListener("resize", () => {
			this.iterateAllLeaves((l) => l.onResize());
			this.trigger("resize");
		});
	}

	#newRootTabs(index?: number) {
		const tabs = new WorkspaceTabs(this.app);
		tabs.onEmpty = () => {
			if (this.rootSplit.children.length > 1) this.rootSplit.removeChild(tabs);
			else {
				// The root always keeps one leaf, like Obsidian's empty "New tab".
				const leaf = new WorkspaceLeaf(this.app);
				tabs.insertChild(0, leaf);
				this.setActiveLeaf(leaf);
			}
		};
		this.rootSplit.addChild(tabs, index);
		return tabs;
	}

	createView(leaf: WorkspaceLeaf, type: string): View {
		const creator = this.app.viewRegistry.getViewCreatorByType(type) ?? this.app.viewRegistry.getViewCreatorByType("empty");
		return creator!(leaf);
	}

	get activeEditor() {
		const view: any = this.activeLeaf?.view;
		return view?.editor ? view : null;
	}

	get rootTabs(): WorkspaceTabs[] {
		return this.rootSplit.children as WorkspaceTabs[];
	}

	onLayoutReady(cb: () => any) {
		if (this.layoutReady) setTimeout(cb);
		else this.#layoutReadyCallbacks.push(cb);
	}

	setLayoutReady() {
		this.layoutReady = true;
		for (const cb of this.#layoutReadyCallbacks.splice(0)) {
			try {
				cb();
			} catch (err) {
				console.error(err);
			}
		}
		this.trigger("layout-ready");
	}

	setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean } | boolean) {
		const focus = typeof params === "boolean" ? params : params?.focus;
		const changed = this.activeLeaf !== leaf;
		this.activeLeaf = leaf;
		leaf.parent?.selectTab(leaf);
		for (const el of document.querySelectorAll(".workspace-leaf.mod-active")) el.removeClass("mod-active");
		leaf.containerEl.addClass("mod-active");
		if (this.isRootLeaf(leaf)) {
			this.#recentRootLeaves.remove(leaf);
			this.#recentRootLeaves.push(leaf);
		}
		if (focus) (leaf.view as any).editor?.focus();
		if (changed) {
			this.trigger("active-leaf-change", leaf);
			const file = leaf.view instanceof FileView ? leaf.view.file : null;
			if (file && file !== this.#lastActiveFile) {
				this.#lastActiveFile = file;
				this.trigger("file-open", file);
			}
		}
	}

	onLeafStateChange(leaf: WorkspaceLeaf) {
		if (leaf.view instanceof FileView && leaf.view.file) {
			const file = leaf.view.file;
			this.#lastOpenFiles = [file.path, ...this.#lastOpenFiles.filter((p) => p !== file.path)].slice(0, 10);
			if (leaf === this.activeLeaf && file !== this.#lastActiveFile) {
				this.#lastActiveFile = file;
				this.trigger("file-open", file);
			}
		}
		this.trigger("layout-change");
		this.requestSaveLayout();
	}

	onLeafDetached(leaf: WorkspaceLeaf) {
		this.#recentRootLeaves.remove(leaf);
		if (this.activeLeaf === leaf) {
			this.activeLeaf = null;
			const next = this.getMostRecentLeaf();
			if (next) this.setActiveLeaf(next, { focus: true });
		}
		this.trigger("layout-change");
		this.requestSaveLayout();
	}

	isRootLeaf(leaf: WorkspaceLeaf) {
		return leaf.getRoot() === this.rootSplit;
	}

	getMostRecentLeaf(_root?: WorkspaceParent) {
		const recent = this.#recentRootLeaves.last();
		if (recent) return recent;
		let first: WorkspaceLeaf | null = null;
		this.iterateRootLeaves((l) => {
			first ??= l;
		});
		return first;
	}

	#activeRootTabs() {
		const leaf = this.activeLeaf && this.isRootLeaf(this.activeLeaf) ? this.activeLeaf : this.getMostRecentLeaf();
		return leaf?.parent ?? this.rootTabs[0];
	}

	getLeaf(newLeaf?: boolean | PaneType) {
		if (newLeaf === "split") return this.splitActiveLeaf("vertical");
		const tabs = this.#activeRootTabs();
		if (!newLeaf) {
			const recent = this.getMostRecentLeaf();
			if (recent && !recent.pinned) return recent;
		}
		const leaf = new WorkspaceLeaf(this.app);
		const anchor = this.activeLeaf && tabs.children.includes(this.activeLeaf) ? tabs.children.indexOf(this.activeLeaf) + 1 : tabs.children.length;
		tabs.insertChild(anchor, leaf);
		return leaf;
	}

	getUnpinnedLeaf() {
		return this.getLeaf(false);
	}

	splitActiveLeaf(_direction?: "vertical" | "horizontal") {
		const tabs = this.#activeRootTabs();
		const group = this.#newRootTabs(this.rootSplit.children.indexOf(tabs) + 1);
		const leaf = new WorkspaceLeaf(this.app);
		group.insertChild(0, leaf);
		return leaf;
	}

	createLeafBySplit(_leaf: WorkspaceLeaf, direction?: "vertical" | "horizontal") {
		return this.splitActiveLeaf(direction);
	}

	duplicateLeaf(leaf: WorkspaceLeaf, leafType?: boolean | PaneType) {
		const next = this.getLeaf(leafType ?? true);
		return next.setViewState(leaf.getViewState()).then(() => next);
	}

	createLeafInParent(parent: WorkspaceParent, index: number) {
		const leaf = new WorkspaceLeaf(this.app);
		if (parent instanceof WorkspaceTabs) parent.insertChild(index, leaf);
		else if (parent instanceof WorkspaceSidedock) parent.tabs.insertChild(index, leaf);
		return leaf;
	}

	#sideLeaf(dock: WorkspaceSidedock) {
		const leaf = new WorkspaceLeaf(this.app);
		dock.tabs.insertChild(dock.tabs.children.length, leaf);
		return leaf;
	}

	getLeftLeaf(_split: boolean) {
		return this.#sideLeaf(this.leftSplit);
	}

	getRightLeaf(_split: boolean) {
		return this.#sideLeaf(this.rightSplit);
	}

	async ensureSideLeaf(type: string, side: "left" | "right", options?: { active?: boolean; split?: boolean; reveal?: boolean; state?: any }) {
		const existing = this.getLeavesOfType(type)[0];
		const leaf = existing ?? (side === "left" ? this.getLeftLeaf(false) : this.getRightLeaf(false));
		if (!existing) await leaf.setViewState({ type, state: options?.state, active: options?.active });
		if (options?.reveal !== false) await this.revealLeaf(leaf);
		return leaf;
	}

	getLeavesOfType(type: string) {
		const leaves: WorkspaceLeaf[] = [];
		this.iterateAllLeaves((l) => {
			if (l.view.getViewType() === type) leaves.push(l);
		});
		return leaves;
	}

	getLeafById(id: string) {
		let found: WorkspaceLeaf | null = null;
		this.iterateAllLeaves((l) => {
			if (l.id === id) found = l;
		});
		return found;
	}

	iterateRootLeaves(cb: (leaf: WorkspaceLeaf) => any) {
		for (const tabs of this.rootTabs) for (const l of [...tabs.children]) if (cb(l)) return true;
		return false;
	}

	iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => any) {
		this.iterateRootLeaves(cb);
		for (const dock of [this.leftSplit, this.rightSplit]) for (const l of [...dock.tabs.children]) cb(l);
	}

	iterateCodeMirrors(_cb: (cm: any) => any) {}

	detachLeavesOfType(type: string) {
		for (const l of this.getLeavesOfType(type)) l.detach();
	}

	async revealLeaf(leaf: WorkspaceLeaf) {
		const root = leaf.getRoot();
		if (root instanceof WorkspaceSidedock && root.collapsed) root.expand();
		leaf.parent?.selectTab(leaf);
	}

	getActiveViewOfType<T extends View>(type: abstract new (...args: any[]) => T): T | null {
		const view = this.activeLeaf?.view;
		return view instanceof type ? view : null;
	}

	getActiveFile(): TFile | null {
		const view = this.activeLeaf?.view;
		if (view instanceof FileView) return view.file;
		return this.#lastActiveFile;
	}

	getLastOpenFiles() {
		return [...this.#lastOpenFiles];
	}

	async openLinkText(linktext: string, sourcePath: string, newLeaf?: boolean | PaneType, openViewState?: any) {
		const { path, subpath } = parseLinktext(linktext);
		let file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		if (!file) file = await this.app.fileManager.createNewMarkdownFileFromLinktext(path, sourcePath);
		const leaf = this.getLeaf(newLeaf);
		await leaf.openFile(file, openViewState);
		if (subpath) this.#scrollToSubpath(leaf, file, subpath);
	}

	#scrollToSubpath(leaf: WorkspaceLeaf, file: TFile, subpath: string) {
		const cache = this.app.metadataCache.getFileCache(file);
		const heading = cache?.headings?.find((h) => `#${h.heading}` === subpath);
		const editor = (leaf.view as any).editor;
		if (heading && editor) {
			const pos = { line: heading.position.start.line, ch: 0 };
			editor.setCursor(pos);
			editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}

	openPopoutLeaf() {
		return this.getLeaf("tab");
	}

	moveLeafToPopout(leaf: WorkspaceLeaf) {
		return leaf;
	}

	registerEditorExtension(ext: Extension) {
		this.editorExtensions.push(ext);
		this.updateOptions();
	}

	unregisterEditorExtension(ext: Extension) {
		this.editorExtensions.remove(ext);
		this.updateOptions();
	}

	// Reapply registered editor extensions to every open Markdown editor.
	updateOptions() {
		this.iterateAllLeaves((l) => (l.view as any).reconfigureExtensions?.());
	}

	#saveLayout = debounce(() => this.app.saveLayoutState(), 1000, true);

	requestSaveLayout() {
		this.#saveLayout();
	}

	getLayout() {
		const leaves: ViewState[] = [];
		this.iterateRootLeaves((l) => {
			leaves.push(l.getViewState());
		});
		return { main: leaves, active: this.activeLeaf?.id, left: { collapsed: this.leftSplit.collapsed }, right: { collapsed: this.rightSplit.collapsed } };
	}

	async changeLayout(layout: any) {
		await this.app.restoreLayoutState(layout);
	}

	handleLinkClick(evt: MouseEvent, sourcePath: string, href: string) {
		const newLeaf = Keymap.isModEvent(evt);
		this.openLinkText(href, sourcePath, newLeaf);
	}
}
