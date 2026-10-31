import type { Extension } from "@codemirror/state";
import type { App } from "./app";
import { Editor } from "./editor";
import { Events } from "./events";
import { setIcon, setTooltip } from "./icons";
import { Keymap } from "./keymap";
import { MarkdownRenderer } from "./markdown";
import type { CachedMetadata } from "./metadata";
import { parseLinktext, stripHeading } from "./metadata-utils";
import { Menu } from "./ui/menu";
import { type HoverParent, HoverPopover, PopoverState } from "./ui/popover";
import type { EditorSuggest } from "./ui/suggest";
import { type Debouncer, debounce } from "./util";
import type { TAbstractFile, TFile } from "./vault";
import { FileView, ItemView, TextFileView, type View, type ViewState } from "./view";

export type PaneType = "tab" | "split" | "window";
export type SplitDirection = "vertical" | "horizontal";
export type Side = "primary" | "secondary" | "left" | "right";

export interface OpenViewState {
	state?: Record<string, unknown>;
	eState?: Record<string, unknown>;
	active?: boolean;
	group?: WorkspaceLeaf;
}

// What getViewState() returns and the layout stores: icon and title let a
// leaf show its tab before its view is available.
export type LeafViewState = ViewState & { icon?: string; title?: string };

interface MarkdownFileInfo extends HoverParent {
	app: App;
	file: TFile | null;
	editor?: Editor;
}

// Obsidian's id format: 8 random bytes as hex, stable across restarts because
// the layout stores it.
function randomId() {
	return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fileOf(view: View) {
	return view instanceof FileView ? view.file : null;
}

// A file view with nothing to show: it needs a file and has none, or its file
// was deleted. What is typed into one is never saved.
function showsNoFile(view: View) {
	if (!(view instanceof FileView)) return false;
	return view.file ? view.app.vault.getAbstractFileByPath(view.file.path) !== view.file : !view.allowNoFile;
}

// Leaves showing a recorded state again (going back or forward, a restored
// layout, a reopened tab); such a load adds no history entry.
const replaying = new WeakSet<WorkspaceLeaf>();

async function replay(leaf: WorkspaceLeaf, state: ViewState, eState?: any) {
	replaying.add(leaf);
	try {
		await leaf.setViewState(state, eState);
	} finally {
		replaying.delete(leaf);
	}
}

export abstract class WorkspaceItem extends Events {
	app: App;
	id: string;
	containerEl: HTMLElement;
	parent: WorkspaceParent | null = null;
	// Percentage of the parent split's length, or null for an equal share.
	dimension: number | null = null;
	resizeHandleEl: HTMLElement | null = null;

	constructor(app: App, containerEl: HTMLElement, id = randomId()) {
		super();
		this.app = app;
		this.containerEl = containerEl;
		this.id = id;
	}

	getRoot(): WorkspaceItem {
		let item: WorkspaceItem = this;
		while (item.parent) item = item.parent;
		return item;
	}

	// Sidedocks belong to the main window, so their items report rootSplit.
	getContainer(): WorkspaceContainer {
		for (let item: WorkspaceItem | null = this; item; item = item.parent) {
			if (item instanceof WorkspaceContainer) return item;
		}
		return this.app.workspace.rootSplit;
	}

	setDimension(dimension: number | null) {
		this.dimension = dimension;
		this.containerEl.style.flexGrow = dimension === null ? "" : String(dimension);
	}

	abstract serialize(): any;
}

export abstract class WorkspaceParent extends WorkspaceItem {
	children: WorkspaceItem[] = [];

	abstract insertChild(index: number, child: WorkspaceItem): void;
	abstract removeChild(child: WorkspaceItem): void;

	// Inserting first keeps a split from collapsing while it has one child.
	replaceChild(index: number, child: WorkspaceItem) {
		const old = this.children[index];
		if (!old) return;
		this.insertChild(index, child);
		this.removeChild(old);
	}
}

export interface HistoryState {
	title: string;
	icon: string;
	state: ViewState;
	eState: any;
}

// A leaf's back/forward navigation; the nearest entry is last in each stack.
export class LeafHistory {
	backHistory: HistoryState[] = [];
	forwardHistory: HistoryState[] = [];
	#current: () => HistoryState | null;
	#apply: (state: HistoryState) => Promise<void>;

	// `current` is null for a view that cannot report its state; leaving it
	// still works, there is just no way back to it.
	constructor(current: () => HistoryState | null, apply: (state: HistoryState) => Promise<void>) {
		this.#current = current;
		this.#apply = apply;
	}

	pushState(state: HistoryState) {
		this.backHistory.push(state);
		if (this.backHistory.length > 50) this.backHistory.shift();
		this.forwardHistory.length = 0;
	}

	back() {
		return this.go(-1);
	}

	forward() {
		return this.go(1);
	}

	// Moves |delta| entries; the current state and the skipped ones go to the
	// other stack, so going the other way returns through them.
	async go(delta: number) {
		const from = delta < 0 ? this.backHistory : this.forwardHistory;
		const to = delta < 0 ? this.forwardHistory : this.backHistory;
		const steps = Math.min(Math.abs(delta), from.length);
		if (!steps) return;
		const current = this.#current();
		if (current) to.push(current);
		for (let i = 1; i < steps; i++) to.push(from.pop()!);
		await this.#apply(from.pop()!);
	}
}

// Stands in for a view whose type is not registered (a plugin that loads late
// or is disabled): it keeps the saved state, so the layout keeps the leaf and
// the leaf comes back once the type is registered.
class PlaceholderView extends ItemView {
	viewState: LeafViewState;

	constructor(leaf: WorkspaceLeaf, viewState: LeafViewState) {
		super(leaf);
		this.viewState = { type: viewState.type, state: viewState.state ?? {}, icon: viewState.icon, title: viewState.title };
	}

	getViewType() {
		return this.viewState.type;
	}

	getState() {
		return this.viewState.state ?? {};
	}

	async setState(state: any) {
		this.viewState.state = state ?? {};
	}

	getDisplayText() {
		return this.viewState.title || this.viewState.type;
	}

	getIcon() {
		return this.viewState.icon || "puzzle";
	}

	async onOpen() {
		const empty = this.contentEl.createDiv("empty-state");
		empty.createDiv({ cls: "empty-state-title", text: "This view is not available" });
		empty.createDiv({ cls: "empty-state-message", text: `The plugin that provides "${this.viewState.type}" is not loaded.` });
	}
}

export class WorkspaceLeaf extends WorkspaceItem implements HoverParent {
	declare parent: WorkspaceTabs | null;
	view: View;
	hoverPopover: HoverPopover | null = null;
	tabHeaderEl: HTMLElement;
	tabHeaderInnerIconEl: HTMLElement;
	tabHeaderInnerTitleEl: HTMLElement;
	tabHeaderStatusContainerEl: HTMLElement;
	tabHeaderCloseEl: HTMLElement;
	pinned = false;
	group: string | null = null;
	// When the leaf was last active, for getMostRecentLeaf.
	activeTime = 0;
	history: LeafHistory;

	constructor(app: App, id?: string) {
		super(app, createDiv("workspace-leaf"), id);
		this.tabHeaderEl = createDiv("workspace-tab-header");
		const inner = this.tabHeaderEl.createDiv("workspace-tab-header-inner");
		this.tabHeaderInnerIconEl = inner.createDiv("workspace-tab-header-inner-icon");
		this.tabHeaderInnerTitleEl = inner.createDiv("workspace-tab-header-inner-title");
		this.tabHeaderStatusContainerEl = inner.createDiv("workspace-tab-header-status-container");
		this.tabHeaderCloseEl = inner.createDiv("workspace-tab-header-inner-close-button");
		setIcon(this.tabHeaderCloseEl, "x");
		this.tabHeaderCloseEl.addEventListener("click", (evt) => {
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
		this.tabHeaderEl.addEventListener("contextmenu", (evt) => this.#showTabMenu(evt));
		// Clicking into a leaf, or focus moving into it (a view focusing its
		// own input, as terminal does), makes it the active leaf.
		this.containerEl.addEventListener("mousedown", () => this.app.workspace.setActiveLeaf(this), true);
		this.containerEl.addEventListener("focusin", () => this.app.workspace.setActiveLeaf(this));
		this.history = new LeafHistory(
			() => this.#historyState(),
			(entry) => replay(this, entry.state, entry.eState),
		);
		this.view = this.app.workspace.createView(this, "empty");
		this.containerEl.appendChild(this.view.containerEl);
		this.view.open(this.containerEl);
		this.updateHeader();
	}

	// Views are never deferred here; that is what plugins written for 1.7.2 handle.
	get isDeferred() {
		return false;
	}

	async loadIfDeferred() {}

	async open(view: View) {
		const old = this.view;
		// A plugin view failing to close must not leave the leaf without a view.
		if (old) await old.close().catch((err) => console.error(err));
		this.containerEl.empty();
		this.view = view;
		this.containerEl.appendChild(view.containerEl);
		await view.open(this.containerEl);
		this.updateHeader();
		return view;
	}

	async setViewState(viewState: ViewState, eState?: any) {
		const workspace = this.app.workspace;
		const before = this.view;
		const beforeFile = fileOf(before);
		const entry = before.navigation && !replaying.has(this) && !showsNoFile(before) ? this.#historyState() : null;
		if (viewState.pinned !== undefined) this.setPinned(viewState.pinned);
		if (viewState.group) this.setGroupMember(viewState.group);
		const needsView = () =>
			this.view.getViewType() !== viewState.type || (this.view instanceof PlaceholderView && !!this.app.viewRegistry.getViewCreatorByType(viewState.type));
		if (needsView()) await this.open(workspace.createView(this, viewState.type, viewState));
		// The type may have been registered while its placeholder was opening.
		if (needsView()) await this.open(workspace.createView(this, viewState.type, viewState));
		const result = { history: false };
		await this.view.setState(viewState.state ?? {}, result);
		if (eState) this.view.setEphemeralState(eState);
		const swapped = this.view !== before || fileOf(this.view) !== beforeFile;
		if (entry && (result.history || swapped)) this.history.pushState(entry);
		this.updateHeader();
		workspace.onLeafViewChanged(this, swapped);
		if (viewState.active) workspace.setActiveLeaf(this, { focus: true });
		if (swapped) this.#syncGroup();
	}

	getViewState(): LeafViewState {
		const state: LeafViewState = { type: this.view.getViewType(), state: this.view.getState(), icon: this.view.getIcon(), title: this.view.getDisplayText() };
		if (this.pinned) state.pinned = true;
		return state;
	}

	async openFile(file: TFile, openState: OpenViewState = {}) {
		// A file view that accepts the file keeps showing it (a plugin's own view
		// of Markdown stays itself); otherwise the extension's view takes over.
		const keep = this.view instanceof FileView && this.view.canAcceptExtension(file.extension);
		const type = keep ? this.view.getViewType() : (this.app.viewRegistry.getTypeByExtension(file.extension) ?? (file.extension === "md" ? "markdown" : undefined));
		// A file no view can show opens in the system's default app rather than
		// as text, which a save would write back over the binary. A tab opened
		// just for it (empty and never active) goes away again.
		if (!type) {
			this.app.openWithDefaultApp(file.path);
			if (this.view.getViewType() === "empty" && !this.activeTime) this.detach();
			return;
		}
		await this.setViewState({ type, state: { ...openState.state, file: file.path }, active: openState.active ?? true, group: openState.group }, openState.eState);
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
		const title = this.view.getDisplayText();
		setIcon(this.tabHeaderInnerIconEl, this.view.getIcon());
		this.tabHeaderInnerTitleEl.setText(title);
		setTooltip(this.tabHeaderEl, title);
		this.tabHeaderEl.setAttr("data-type", this.view.getViewType());
		if (this.view instanceof ItemView) this.view.titleEl.setText(title);
	}

	setPinned(pinned: boolean) {
		if (this.pinned === pinned) return;
		this.pinned = pinned;
		this.tabHeaderEl.toggleClass("is-pinned", pinned);
		this.#updateStatusIcons();
		this.trigger("pinned-change", pinned);
		this.app.workspace.requestSaveLayout();
	}

	togglePinned() {
		this.setPinned(!this.pinned);
	}

	// Whether following a link may replace what this leaf shows.
	canNavigate() {
		return !this.pinned && this.view.navigation;
	}

	setGroup(group: string | null) {
		if (this.group === group) return;
		this.group = group;
		this.#updateStatusIcons();
		this.trigger("group-change", group);
		this.app.workspace.requestSaveLayout();
	}

	// Joins other's group, or starts one for both; null leaves the group.
	setGroupMember(other: WorkspaceLeaf | null) {
		if (!other) return this.setGroup(null);
		const group = other.group ?? randomId();
		other.setGroup(group);
		this.setGroup(group);
	}

	onResize() {
		this.view.onResize();
	}

	detach() {
		const parent = this.parent;
		if (!parent) return;
		const workspace = this.app.workspace;
		workspace.onLeafClosing(this);
		this.hoverPopover?.hide();
		parent.removeChild(this);
		this.view.close().catch((err) => console.error(err));
		workspace.onLeafDetached(this, parent);
	}

	serialize() {
		let state: LeafViewState;
		try {
			state = this.getViewState();
		} catch (err) {
			// One broken plugin view must not keep the whole layout from saving.
			console.error(err);
			state = { type: this.view.getViewType(), state: {} };
		}
		const data: Record<string, unknown> = { id: this.id, type: "leaf", state };
		if (this.group) data.group = this.group;
		return data;
	}

	// Null when the view cannot report its state (logged): a broken plugin view
	// must still be replaceable, it just leaves no entry to come back to.
	#historyState(): HistoryState | null {
		try {
			const { pinned: _pinned, ...state } = this.getViewState();
			return { title: this.getDisplayText(), icon: this.getIcon(), state, eState: this.getEphemeralState() };
		} catch (err) {
			console.error(err);
			return null;
		}
	}

	// Linked FileViews keep showing the same file.
	#syncGroup() {
		const file = fileOf(this.view);
		if (!this.group || !file) return;
		for (const other of this.app.workspace.getGroupLeaves(this.group)) {
			if (other === this || !(other.view instanceof FileView) || other.view.file === file) continue;
			const state = other.getViewState();
			other.setViewState({ ...state, state: { ...state.state, file: file.path } }).catch((err) => console.error(err));
		}
	}

	#updateStatusIcons() {
		const container = this.tabHeaderStatusContainerEl;
		container.empty();
		if (this.pinned) {
			const pin = container.createDiv("workspace-tab-header-status-icon mod-pinned");
			setIcon(pin, "pin");
			setTooltip(pin, "Unpin");
			pin.addEventListener("click", (evt) => {
				evt.stopPropagation();
				this.setPinned(false);
			});
		}
		if (this.group) setIcon(container.createDiv("workspace-tab-header-status-icon mod-linked"), "link");
	}

	#showTabMenu(evt: MouseEvent) {
		const workspace = this.app.workspace;
		// Only "Close" closes a pinned tab; the bulk closes spare pinned tabs.
		const close = (leaves: WorkspaceLeaf[]) => {
			for (const leaf of leaves) if (!leaf.pinned) leaf.detach();
		};
		const siblings = () => [...(this.parent?.children ?? [])];
		const menu = new Menu();
		menu.addItem((i) => i.setSection("close").setTitle("Close").setIcon("x").onClick(() => this.detach()));
		menu.addItem((i) =>
			i
				.setSection("close")
				.setTitle("Close others")
				.setIcon("x-square")
				.onClick(() => close(siblings().filter((l) => l !== this))),
		);
		menu.addItem((i) =>
			i
				.setSection("close")
				.setTitle("Close tabs to the right")
				.setIcon("arrow-right-to-line")
				.onClick(() => close(siblings().slice(siblings().indexOf(this) + 1))),
		);
		menu.addItem((i) =>
			i
				.setSection("close")
				.setTitle("Close all")
				.setIcon("x-circle")
				.onClick(() => close(siblings())),
		);
		menu.addItem((i) =>
			i
				.setSection("pane")
				.setTitle(this.pinned ? "Unpin" : "Pin")
				.setIcon(this.pinned ? "pin-off" : "pin")
				.onClick(() => this.togglePinned()),
		);
		if (workspace.isRootLeaf(this)) {
			menu.addItem((i) =>
				i
					.setSection("pane")
					.setTitle("Split right")
					.setIcon("separator-vertical")
					.onClick(() => workspace.duplicateLeaf(this, "split", "vertical")),
			);
			menu.addItem((i) =>
				i
					.setSection("pane")
					.setTitle("Split down")
					.setIcon("separator-horizontal")
					.onClick(() => workspace.duplicateLeaf(this, "split", "horizontal")),
			);
		}
		this.view.onPaneMenu(menu, "tab-header");
		workspace.trigger("leaf-menu", menu, this);
		menu.showAtMouseEvent(evt);
	}
}

// A tab group: tab headers plus one visible leaf.
export class WorkspaceTabs extends WorkspaceParent {
	declare parent: WorkspaceSplit | null;
	declare children: WorkspaceLeaf[];
	headerEl: HTMLElement;
	tabHeaderContainerEl: HTMLElement;
	tabsContainerEl: HTMLElement;
	currentTab = 0;

	constructor(app: App, id?: string) {
		super(app, createDiv("workspace-tabs"), id);
		this.headerEl = this.containerEl.createDiv("workspace-tab-header-container");
		this.tabHeaderContainerEl = this.headerEl.createDiv("workspace-tab-header-container-inner");
		const newTab = this.headerEl.createDiv("workspace-tab-header-new-tab clickable-icon");
		setIcon(newTab, "plus");
		setTooltip(newTab, "New tab");
		newTab.addEventListener("click", () => {
			const leaf = new WorkspaceLeaf(this.app);
			this.insertChild(this.children.length, leaf);
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		});
		this.headerEl.createDiv("workspace-tab-header-spacer");
		this.tabsContainerEl = this.containerEl.createDiv("workspace-tab-container");
	}

	// A new tab stays in the background (activating or revealing it shows it),
	// except as the first tab of the group.
	insertChild(index: number, leaf: WorkspaceLeaf) {
		const shown = this.children[this.currentTab];
		leaf.parent = this;
		this.children.splice(index, 0, leaf);
		this.tabHeaderContainerEl.insertBefore(leaf.tabHeaderEl, this.tabHeaderContainerEl.children[index] ?? null);
		this.tabsContainerEl.appendChild(leaf.containerEl);
		this.selectTab(shown ?? leaf);
		this.app.workspace.onLayoutChange();
	}

	removeChild(leaf: WorkspaceLeaf) {
		const index = this.children.indexOf(leaf);
		if (index < 0) return;
		this.children.splice(index, 1);
		leaf.parent = null;
		leaf.tabHeaderEl.detach();
		leaf.containerEl.detach();
		if (this.children.length) {
			// The visible tab stays visible unless it is the one removed.
			this.selectTabIndex(index < this.currentTab ? this.currentTab - 1 : Math.min(this.currentTab, this.children.length - 1));
		} else {
			this.currentTab = 0;
			this.app.workspace.onEmptyTabs(this);
		}
		this.app.workspace.onLayoutChange();
	}

	selectTab(leaf: WorkspaceLeaf) {
		const index = this.children.indexOf(leaf);
		if (index >= 0) this.selectTabIndex(index);
	}

	selectTabIndex(index: number) {
		const leaf = this.children[index];
		if (!leaf) return;
		const changed = this.currentTab !== index || !leaf.tabHeaderEl.hasClass("is-active");
		this.currentTab = index;
		for (const c of this.children) {
			const on = c === leaf;
			c.tabHeaderEl.toggleClass("is-active", on);
			c.containerEl.toggle(on);
		}
		if (changed) {
			leaf.onResize();
			this.app.workspace.onLayoutChange();
		}
	}

	serialize() {
		const data: Record<string, unknown> = { id: this.id, type: "tabs", children: this.children.map((c) => c.serialize()) };
		if (this.currentTab) data.currentTab = this.currentTab;
		if (this.dimension !== null) data.dimension = this.dimension;
		return data;
	}
}

// Children sit side by side ("vertical") or stacked ("horizontal"). A nested
// split with one child left is replaced by that child.
export class WorkspaceSplit extends WorkspaceParent {
	declare children: (WorkspaceTabs | WorkspaceSplit)[];
	direction: SplitDirection;

	constructor(app: App, direction: SplitDirection, cls = "", id?: string) {
		super(app, createDiv(`workspace-split mod-${direction} ${cls}`.trim()), id);
		this.direction = direction;
	}

	setDirection(direction: SplitDirection) {
		this.containerEl.removeClass(`mod-${this.direction}`);
		this.containerEl.addClass(`mod-${direction}`);
		this.direction = direction;
	}

	insertChild(index: number, child: WorkspaceTabs | WorkspaceSplit) {
		child.parent = this;
		this.children.splice(index, 0, child);
		this.containerEl.insertBefore(child.containerEl, this.children[index + 1]?.containerEl ?? null);
		if (!child.resizeHandleEl) {
			const handle = child.containerEl.createEl("hr", { cls: "workspace-leaf-resize-handle" });
			handle.addEventListener("pointerdown", (evt) => {
				if (child.parent instanceof WorkspaceSplit) child.parent.#resize(evt, child);
			});
			child.resizeHandleEl = handle;
		}
		// Sized siblings would squeeze an unsized newcomer to nothing.
		const sized = this.children.filter((c) => c.dimension !== null);
		if (child.dimension === null && sized.length) child.setDimension(sized.reduce((sum, c) => sum + c.dimension!, 0) / sized.length);
		this.#updateHandles();
		this.app.workspace.onLayoutChange();
	}

	removeChild(child: WorkspaceTabs | WorkspaceSplit) {
		const index = this.children.indexOf(child);
		if (index < 0) return;
		this.children.splice(index, 1);
		child.parent = null;
		child.containerEl.detach();
		this.#updateHandles();
		this.#collapse();
		this.app.workspace.onLayoutChange();
	}

	serialize() {
		const data: Record<string, unknown> = { id: this.id, type: "split", children: this.children.map((c) => c.serialize()), direction: this.direction };
		if (this.dimension !== null) data.dimension = this.dimension;
		return data;
	}

	// Lifts the only child into this split's place (its children, when it
	// splits the same way as the parent); an empty split just goes.
	#collapse() {
		const parent = this.parent;
		if (!(parent instanceof WorkspaceSplit) || this.children.length > 1) return;
		const only = this.children[0];
		if (only) {
			const lifted = only instanceof WorkspaceSplit && only.direction === parent.direction ? only.children.splice(0) : [only];
			this.children = [];
			for (const c of lifted) {
				c.parent = null;
				c.containerEl.detach();
				c.setDimension(lifted.length === 1 ? this.dimension : null);
			}
			const index = parent.children.indexOf(this);
			for (const [i, c] of lifted.entries()) parent.insertChild(index + 1 + i, c);
		}
		parent.removeChild(this);
	}

	#updateHandles() {
		for (const [i, c] of this.children.entries()) c.resizeHandleEl?.toggle(i < this.children.length - 1);
	}

	// Drags the boundary after `child`, trading length with the next sibling.
	#resize(evt: PointerEvent, child: WorkspaceTabs | WorkspaceSplit) {
		const index = this.children.indexOf(child);
		const next = this.children[index + 1];
		if (!next || evt.button !== 0) return;
		evt.preventDefault();
		const vertical = this.direction === "vertical";
		const sizes = this.children.map((c) => (vertical ? c.containerEl.offsetWidth : c.containerEl.offsetHeight));
		const total = sizes.reduce((a, b) => a + b, 0) || 1;
		for (const [i, c] of this.children.entries()) c.setDimension((sizes[i] / total) * 100);
		const start = vertical ? evt.clientX : evt.clientY;
		const pair = sizes[index] + sizes[index + 1];
		const min = Math.min(80, pair / 2);
		const handle = evt.currentTarget as HTMLElement;
		handle.setPointerCapture(evt.pointerId);
		const move = (e: PointerEvent) => {
			const a = Math.clamp(sizes[index] + (vertical ? e.clientX : e.clientY) - start, min, pair - min);
			child.setDimension((a / total) * 100);
			next.setDimension(((pair - a) / total) * 100);
			this.app.workspace.requestResize();
		};
		const up = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			this.app.workspace.onLayoutChange();
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
	}
}

export abstract class WorkspaceContainer extends WorkspaceSplit {
	abstract win: Window;
	abstract doc: Document;
}

export class WorkspaceRoot extends WorkspaceContainer {
	win = window;
	doc = document;

	constructor(app: App) {
		super(app, "vertical", "mod-root");
	}
}

// Popout windows are not supported; this exists so instanceof checks work.
export class WorkspaceWindow extends WorkspaceContainer {
	win = window;
	doc = document;
}

// Would hold popout windows; always empty.
export class WorkspaceFloating extends WorkspaceParent {
	declare children: WorkspaceWindow[];

	constructor(app: App) {
		super(app, createDiv("workspace-floating"));
	}

	insertChild(index: number, child: WorkspaceWindow) {
		child.parent = this;
		this.children.splice(index, 0, child);
	}

	removeChild(child: WorkspaceWindow) {
		this.children.remove(child);
		child.parent = null;
	}

	serialize() {
		return { id: this.id, type: "floating", children: [] };
	}
}

export class WorkspaceSidedock extends WorkspaceSplit {
	collapsed = false;
	side: "left" | "right";
	width = 280;

	constructor(app: App, side: "left" | "right") {
		super(app, "horizontal", `mod-${side}-split mod-sidedock`);
		this.side = side;
		this.setWidth(this.width);
		const handle = this.containerEl.createEl("hr", { cls: "workspace-leaf-resize-handle" });
		handle.addEventListener("pointerdown", (evt) => this.#resizeWidth(evt));
		this.resizeHandleEl = handle;
	}

	setWidth(width: number) {
		this.width = Math.round(Math.clamp(width, 160, Math.max(160, window.innerWidth * 0.6)));
		this.containerEl.style.width = `${this.width}px`;
	}

	toggle() {
		this.collapsed ? this.expand() : this.collapse();
	}

	collapse() {
		if (this.collapsed) return;
		this.collapsed = true;
		this.containerEl.addClass("is-collapsed");
		this.app.workspace.onLayoutChange();
	}

	expand() {
		if (!this.collapsed) return;
		this.collapsed = false;
		this.containerEl.removeClass("is-collapsed");
		this.app.workspace.onLayoutChange();
	}

	serialize() {
		const data = super.serialize();
		data.width = this.width;
		if (this.collapsed) data.collapsed = true;
		return data;
	}

	#resizeWidth(evt: PointerEvent) {
		if (evt.button !== 0) return;
		evt.preventDefault();
		const start = evt.clientX;
		const width = this.width;
		const handle = evt.currentTarget as HTMLElement;
		handle.setPointerCapture(evt.pointerId);
		const move = (e: PointerEvent) => {
			this.setWidth(width + (this.side === "left" ? e.clientX - start : start - e.clientX));
			this.app.workspace.requestResize();
		};
		const up = () => {
			handle.removeEventListener("pointermove", move);
			handle.removeEventListener("pointerup", up);
			this.app.workspace.onLayoutChange();
		};
		handle.addEventListener("pointermove", move);
		handle.addEventListener("pointerup", up);
	}
}

// The mobile sidedock; desktop never creates one.
export class WorkspaceMobileDrawer extends WorkspaceParent {
	collapsed = true;

	insertChild(index: number, child: WorkspaceItem) {
		child.parent = this;
		this.children.splice(index, 0, child);
	}

	removeChild(child: WorkspaceItem) {
		this.children.remove(child);
		child.parent = null;
	}

	expand() {
		this.collapsed = false;
	}

	collapse() {
		this.collapsed = true;
	}

	toggle() {
		this.collapsed = !this.collapsed;
	}

	serialize() {
		return { id: this.id, type: "mobile-drawer", children: [] };
	}
}

interface RibbonItem {
	id: string;
	icon: string;
	title: string;
	callback: (evt: MouseEvent) => any;
	buttonEl: HTMLElement;
}

export class WorkspaceRibbon {
	app: App;
	containerEl: HTMLElement;
	actionsEl: HTMLElement;
	items: RibbonItem[] = [];
	// Item id to hidden, from the saved layout; kept for items not added yet.
	hiddenItems: Record<string, boolean> = {};

	constructor(app: App, side: "left" | "right") {
		this.app = app;
		this.containerEl = createDiv(`workspace-ribbon side-dock-ribbon mod-${side}`);
		this.actionsEl = this.containerEl.createDiv("side-dock-actions");
		this.containerEl.addEventListener("contextmenu", (evt) => this.#showMenu(evt));
	}

	addRibbonItemButton(id: string, icon: string, title: string, callback: (evt: MouseEvent) => any) {
		const buttonEl = createDiv({ cls: "clickable-icon side-dock-ribbon-action", attr: { "data-id": id } });
		setIcon(buttonEl, icon);
		setTooltip(buttonEl, title, { placement: "right" });
		buttonEl.addEventListener("click", callback);
		buttonEl.toggle(!this.hiddenItems[id]);
		// Re-adding an id (a plugin reloading its button) takes the old place.
		const old = this.items.findIndex((i) => i.id === id);
		if (old >= 0 && this.items[old].buttonEl.parentElement === this.actionsEl) this.items[old].buttonEl.replaceWith(buttonEl);
		else this.actionsEl.appendChild(buttonEl);
		if (old >= 0) this.items.splice(old, 1);
		this.items.push({ id, icon, title, callback, buttonEl });
		return buttonEl;
	}

	removeRibbonAction(title: string) {
		const index = this.items.findIndex((i) => i.title === title);
		if (index < 0) return;
		this.items[index].buttonEl.detach();
		this.items.splice(index, 1);
	}

	serialize() {
		this.#prune();
		const hiddenItems = { ...this.hiddenItems };
		for (const item of this.items) hiddenItems[item.id] = !!this.hiddenItems[item.id];
		return { hiddenItems };
	}

	// A button its owner removed directly, without removeRibbonAction.
	#prune() {
		this.items = this.items.filter((i) => i.buttonEl.parentElement === this.actionsEl);
	}

	load(data: any) {
		this.hiddenItems = { ...data?.hiddenItems };
		for (const item of this.items) item.buttonEl.toggle(!this.hiddenItems[item.id]);
	}

	#showMenu(evt: MouseEvent) {
		this.#prune();
		if (!this.items.length) return;
		const menu = new Menu();
		for (const item of this.items) {
			menu.addItem((i) =>
				i
					.setTitle(item.title)
					.setIcon(item.icon)
					.setChecked(!this.hiddenItems[item.id])
					.onClick(() => {
						this.hiddenItems[item.id] = !this.hiddenItems[item.id];
						item.buttonEl.toggle(!this.hiddenItems[item.id]);
						this.app.workspace.requestSaveLayout();
					}),
			);
		}
		menu.showAtMouseEvent(evt);
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

// Work to wait for before the app quits; failures do not stop the others.
export class Tasks {
	#promises: Promise<unknown>[] = [];

	add(callback: () => Promise<any>) {
		try {
			this.addPromise(callback());
		} catch (err) {
			this.addPromise(Promise.reject(err));
		}
	}

	addPromise(promise: Promise<any>) {
		this.#promises.push(Promise.resolve(promise).catch((err) => console.error(err)));
	}

	isEmpty() {
		return this.#promises.length === 0;
	}

	promise() {
		return Promise.all(this.#promises);
	}
}

function walkLeaves(item: WorkspaceItem, cb: (leaf: WorkspaceLeaf) => any): boolean {
	if (item instanceof WorkspaceLeaf) return cb(item) === true;
	if (item instanceof WorkspaceParent) for (const child of [...item.children]) if (walkLeaves(child, cb)) return true;
	return false;
}

function tabGroups(item: WorkspaceItem): WorkspaceTabs[] {
	if (item instanceof WorkspaceTabs) return [item];
	return item instanceof WorkspaceParent ? item.children.flatMap(tabGroups) : [];
}

function withTimeout(promise: Promise<unknown>, ms: number) {
	return Promise.race([promise, sleep(ms)]);
}

// The heading or block a subpath names, as a line range of the note.
function subpathLines(cache: CachedMetadata | null, subpath: string): [number, number] | null {
	if (!cache || !subpath) return null;
	if (subpath.startsWith("#^")) {
		const block = cache.blocks?.[subpath.slice(2).toLowerCase()];
		return block ? [block.position.start.line, block.position.end.line] : null;
	}
	const wanted = stripHeading(subpath.split("#").filter(Boolean).last() ?? "").toLowerCase();
	const headings = cache.headings ?? [];
	const index = headings.findIndex((h) => stripHeading(h.heading).toLowerCase() === wanted);
	if (index < 0) return null;
	const level = headings[index].level;
	const end = headings.slice(index + 1).find((h) => h.level <= level);
	return [headings[index].position.start.line, end ? end.position.start.line - 1 : Number.MAX_SAFE_INTEGER];
}

export class Workspace extends Events {
	app: App;
	containerEl: HTMLElement;
	leftRibbon: WorkspaceRibbon;
	// Deprecated in Obsidian ("no longer exists"); never shown.
	rightRibbon: WorkspaceRibbon;
	leftSplit: WorkspaceSidedock;
	rightSplit: WorkspaceSidedock;
	rootSplit: WorkspaceRoot;
	floatingSplit: WorkspaceFloating;
	activeLeaf: WorkspaceLeaf | null = null;
	layoutReady = false;
	editorSuggest = new EditorSuggestManager();
	hoverLinkSources: Record<string, { display: string; defaultMod: boolean }> = {
		editor: { display: "Editor", defaultMod: true },
		preview: { display: "Reading view", defaultMod: false },
	};
	editorExtensions: Extension[] = [];
	// An own property, so plugins can pass it around unbound.
	requestSaveLayout: Debouncer<[], Promise<void>> = debounce(async () => {
		// Before the saved layout is restored, saving would overwrite it.
		if (this.layoutReady) this.app.saveLayoutState();
	}, 1000, true);
	requestUpdateLayout: Debouncer<[], void> = debounce(() => this.iterateAllLeaves((l) => l.updateHeader()), 100, true);
	#layoutReadyCallbacks: (() => any)[] = [];
	#lastOpenFiles: string[] = [];
	// The file last announced with file-open; only for deduplication.
	#activeFile: TFile | null = null;
	#embeddedEditor: MarkdownFileInfo | null = null;
	// While changeLayout rebuilds the tree, per-leaf events wait for the end.
	#restoring = false;
	#clock = 0;
	#closed: { state: LeafViewState; eState: any }[] = [];
	#quitting: Promise<void> | null = null;
	#layoutChanged = debounce(() => {
		this.trigger("layout-change");
		this.requestResize();
		this.requestSaveLayout();
	}, 0);
	#resized = debounce(() => {
		this.iterateAllLeaves((leaf) => {
			const tabs = leaf.parent;
			const dock = leaf.getRoot();
			if (tabs?.children[tabs.currentTab] === leaf && !(dock instanceof WorkspaceSidedock && dock.collapsed)) leaf.onResize();
		});
		this.trigger("resize");
	}, 16);

	constructor(app: App) {
		super();
		this.app = app;
		this.containerEl = createDiv("workspace");
		this.leftRibbon = new WorkspaceRibbon(app, "left");
		this.rightRibbon = new WorkspaceRibbon(app, "right");
		this.leftSplit = new WorkspaceSidedock(app, "left");
		this.rootSplit = new WorkspaceRoot(app);
		this.rightSplit = new WorkspaceSidedock(app, "right");
		this.floatingSplit = new WorkspaceFloating(app);
		this.containerEl.append(this.leftRibbon.containerEl, this.leftSplit.containerEl, this.rootSplit.containerEl, this.rightSplit.containerEl);
		window.addEventListener("resize", () => this.requestResize());
		app.vault.on("rename", (file: TAbstractFile, oldPath: string) => this.#onRename(file, oldPath));
		app.vault.on("delete", (file: TAbstractFile) => this.#onDelete(file));
		this.on("hover-link", (info) => this.#onHoverLink(info));
		this.#watchViewRegistry();
	}

	createView(leaf: WorkspaceLeaf, type: string, viewState: LeafViewState = { type }): View {
		const creator = this.app.viewRegistry.getViewCreatorByType(type);
		return creator ? creator(leaf) : new PlaceholderView(leaf, viewState);
	}

	// The active Markdown editor: the active view when it has an Obsidian
	// Editor (plugin views that keep a raw CodeMirror view in `editor` do not
	// count), or an embedded editor that set itself here.
	get activeEditor(): MarkdownFileInfo | null {
		if (this.#embeddedEditor) return this.#embeddedEditor;
		const view = this.activeLeaf?.view as (View & Partial<MarkdownFileInfo>) | undefined;
		return view?.editor instanceof Editor ? (view as unknown as MarkdownFileInfo) : null;
	}

	set activeEditor(info: MarkdownFileInfo | null) {
		this.#embeddedEditor = info;
	}

	onLayoutReady(cb: () => any) {
		if (this.layoutReady) cb();
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

	// Every tree mutation ends here; listeners hear about a burst once.
	onLayoutChange() {
		this.#layoutChanged();
	}

	requestResize() {
		this.#resized();
	}

	setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean }): void;
	/** @deprecated */
	setActiveLeaf(leaf: WorkspaceLeaf, pushHistory: boolean, focus: boolean): void;
	setActiveLeaf(leaf: WorkspaceLeaf, params?: { focus?: boolean } | boolean, legacyFocus?: boolean) {
		if (!leaf.parent) return;
		const focus = typeof params === "boolean" ? legacyFocus === true : params?.focus === true;
		const changed = this.activeLeaf !== leaf;
		this.activeLeaf = leaf;
		this.#clock = Math.max(Date.now(), this.#clock + 1);
		leaf.activeTime = this.#clock;
		leaf.parent.selectTab(leaf);
		for (const el of document.querySelectorAll(".workspace-leaf.mod-active, .workspace-tabs.mod-active")) el.removeClass("mod-active");
		leaf.containerEl.addClass("mod-active");
		leaf.parent.containerEl.addClass("mod-active");
		if (changed) {
			this.#embeddedEditor = null;
			this.trigger("active-leaf-change", leaf);
		}
		this.#updateActiveFile();
		// Last, so the focusin it causes finds this leaf already active.
		if (focus) this.#focus(leaf);
	}

	#focus(leaf: WorkspaceLeaf) {
		const view = leaf.view as View & { editor?: { focus?: () => void } };
		if (typeof view.editor?.focus === "function") view.editor.focus();
		else if (!view.containerEl.contains(document.activeElement)) {
			if (!view.containerEl.hasAttribute("tabindex")) view.containerEl.tabIndex = -1;
			view.containerEl.focus({ preventScroll: true });
		}
	}

	// After a leaf's setViewState: swapping the active leaf's view or file
	// counts as an active-leaf change.
	onLeafViewChanged(leaf: WorkspaceLeaf, swapped: boolean) {
		this.onLayoutChange();
		if (this.#restoring) return;
		if (swapped && leaf === this.activeLeaf) {
			this.#embeddedEditor = null;
			this.trigger("active-leaf-change", leaf);
		}
		this.#updateActiveFile();
	}

	onLeafClosing(leaf: WorkspaceLeaf) {
		if (!this.isRootLeaf(leaf) || leaf.view.getViewType() === "empty" || showsNoFile(leaf.view)) return;
		try {
			this.#closed.push({ state: leaf.getViewState(), eState: leaf.getEphemeralState() });
		} catch (err) {
			// A view that cannot report its state still closes; it just cannot be reopened.
			console.error(err);
			return;
		}
		if (this.#closed.length > 10) this.#closed.shift();
	}

	onLeafDetached(leaf: WorkspaceLeaf, parent: WorkspaceTabs) {
		if (this.activeLeaf === leaf) {
			this.activeLeaf = null;
			// A main-area tab hands over to the tab now shown in its group.
			const sibling = parent.getRoot() === this.rootSplit ? parent.children[parent.currentTab] : null;
			const next = sibling ?? this.getMostRecentLeaf();
			if (next) this.setActiveLeaf(next, { focus: true });
		}
		this.#updateActiveFile();
		this.onLayoutChange();
	}

	// A tab group lost its last leaf. The main area always keeps one leaf, like
	// Obsidian's empty "New tab"; a sidedock keeps one (possibly empty) group.
	onEmptyTabs(tabs: WorkspaceTabs) {
		const root = tabs.getRoot();
		if (tabGroups(root).length > 1) tabs.parent?.removeChild(tabs);
		else if (root === this.rootSplit) tabs.insertChild(0, new WorkspaceLeaf(this.app));
	}

	isRootLeaf(leaf: WorkspaceLeaf) {
		return leaf.getRoot() === this.rootSplit;
	}

	getMostRecentLeaf(root: WorkspaceParent = this.rootSplit): WorkspaceLeaf | null {
		let best: WorkspaceLeaf | null = null;
		walkLeaves(root, (leaf) => {
			if (!best || leaf.activeTime > best.activeTime) best = leaf;
		});
		return best;
	}

	// The tab group new main-area tabs go to: the active or most recent one.
	#rootTabs(): WorkspaceTabs {
		const recent = this.activeLeaf && this.isRootLeaf(this.activeLeaf) ? this.activeLeaf : this.getMostRecentLeaf();
		const tabs = recent?.parent ?? tabGroups(this.rootSplit)[0];
		if (tabs) return tabs;
		const created = new WorkspaceTabs(this.app);
		this.rootSplit.insertChild(this.rootSplit.children.length, created);
		return created;
	}

	getLeaf(newLeaf?: "split", direction?: SplitDirection): WorkspaceLeaf;
	getLeaf(newLeaf?: PaneType | boolean): WorkspaceLeaf;
	getLeaf(newLeaf?: PaneType | boolean, direction: SplitDirection = "vertical"): WorkspaceLeaf {
		if (newLeaf === "split") {
			const active = this.activeLeaf && this.isRootLeaf(this.activeLeaf) ? this.activeLeaf : this.getMostRecentLeaf();
			return active ? this.createLeafBySplit(active, direction) : this.getLeaf("tab");
		}
		if (newLeaf === "window") return this.openPopoutLeaf();
		if (!newLeaf) {
			const recent = this.getMostRecentLeaf();
			if (recent?.canNavigate()) return recent;
		}
		const tabs = this.#rootTabs();
		const leaf = new WorkspaceLeaf(this.app);
		const anchor = this.activeLeaf ? tabs.children.indexOf(this.activeLeaf) : -1;
		tabs.insertChild(anchor >= 0 ? anchor + 1 : tabs.children.length, leaf);
		return leaf;
	}

	getUnpinnedLeaf() {
		return this.getLeaf(false);
	}

	/** @deprecated use getLeaf("split", direction) */
	splitActiveLeaf(direction?: SplitDirection) {
		return this.getLeaf("split", direction);
	}

	// A new leaf in its own tab group beside `leaf`. When the direction differs
	// from the parent split's, the leaf's group is wrapped in a new split.
	createLeafBySplit(leaf: WorkspaceLeaf, direction: SplitDirection = "vertical", before = false) {
		const tabs = leaf.parent ?? this.#rootTabs();
		const split = tabs.parent ?? this.rootSplit;
		const next = new WorkspaceLeaf(this.app);
		const group = new WorkspaceTabs(this.app);
		group.insertChild(0, next);
		if (tabs.dimension !== null) {
			tabs.setDimension(tabs.dimension / 2);
			group.setDimension(tabs.dimension);
		}
		if (split.direction === direction) {
			split.insertChild(split.children.indexOf(tabs) + (before ? 0 : 1), group);
		} else {
			// The wrapper goes in before the group leaves, so `split` never drops
			// to one child and collapses under us.
			const wrapper = new WorkspaceSplit(this.app, direction);
			split.insertChild(Math.max(0, split.children.indexOf(tabs)), wrapper);
			wrapper.setDimension(tabs.dimension === null ? null : tabs.dimension * 2);
			split.removeChild(tabs);
			tabs.setDimension(null);
			group.setDimension(null);
			wrapper.insertChild(0, tabs);
			wrapper.insertChild(before ? 0 : 1, group);
		}
		return next;
	}

	async duplicateLeaf(leaf: WorkspaceLeaf, leafType?: PaneType | boolean | SplitDirection, direction?: SplitDirection) {
		// The deprecated form passes a direction (or nothing) and always splits.
		if (leafType === undefined || leafType === "vertical" || leafType === "horizontal") {
			direction = leafType ?? direction;
			leafType = "split";
		}
		let next: WorkspaceLeaf;
		if (leafType === "split") next = this.createLeafBySplit(leaf, direction);
		else if (leafType && leafType !== "window" && leaf.parent) {
			next = new WorkspaceLeaf(this.app);
			leaf.parent.insertChild(leaf.parent.children.indexOf(leaf) + 1, next);
		} else next = this.getLeaf(leafType);
		const { pinned: _pinned, ...state } = leaf.getViewState();
		await next.setViewState({ ...state, active: true }, leaf.getEphemeralState());
		return next;
	}

	// For a split parent the leaf gets its own tab group at `index`.
	createLeafInParent(parent: WorkspaceParent, index: number) {
		const leaf = new WorkspaceLeaf(this.app);
		if (parent instanceof WorkspaceTabs) parent.insertChild(index, leaf);
		else if (parent instanceof WorkspaceSplit) {
			const tabs = new WorkspaceTabs(this.app);
			tabs.insertChild(0, leaf);
			parent.insertChild(index, tabs);
		}
		return leaf;
	}

	#sideLeaf(dock: WorkspaceSidedock, split: boolean) {
		const leaf = new WorkspaceLeaf(this.app);
		const existing = split ? undefined : tabGroups(dock)[0];
		if (existing) existing.insertChild(existing.children.length, leaf);
		else {
			const tabs = new WorkspaceTabs(this.app);
			tabs.insertChild(0, leaf);
			dock.insertChild(dock.children.length, tabs);
		}
		return leaf;
	}

	getLeftLeaf(split: boolean) {
		return this.#sideLeaf(this.leftSplit, split);
	}

	getRightLeaf(split: boolean) {
		return this.#sideLeaf(this.rightSplit, split);
	}

	async ensureSideLeaf(type: string, side: Side, options: { active?: boolean; split?: boolean; reveal?: boolean; state?: any } = {}) {
		const dock = side === "left" || side === "primary" ? this.leftSplit : this.rightSplit;
		let leaf = this.getLeavesOfType(type).find((l) => l.getRoot() instanceof WorkspaceSidedock);
		if (leaf) {
			if (options.state) await leaf.setViewState({ type, state: options.state });
		} else {
			leaf = this.#sideLeaf(dock, !!options.split);
			await leaf.setViewState({ type, state: options.state });
		}
		if (options.reveal !== false) await this.revealLeaf(leaf);
		if (options.active) this.setActiveLeaf(leaf, { focus: true });
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
			if (l.id !== id) return false;
			found = l;
			return true;
		});
		return found;
	}

	getGroupLeaves(group: string) {
		const leaves: WorkspaceLeaf[] = [];
		this.iterateAllLeaves((l) => {
			if (l.group === group) leaves.push(l);
		});
		return leaves;
	}

	// Callbacks stop the walk only by returning exactly true, so concise
	// arrows such as `leaf => list.push(leaf)` visit every leaf.
	iterateRootLeaves(cb: (leaf: WorkspaceLeaf) => any) {
		walkLeaves(this.rootSplit, cb);
	}

	iterateAllLeaves(cb: (leaf: WorkspaceLeaf) => any) {
		for (const root of [this.rootSplit, this.leftSplit, this.rightSplit, this.floatingSplit]) if (walkLeaves(root, cb)) return;
	}

	iterateCodeMirrors(_cb: (cm: any) => any) {}

	detachLeavesOfType(type: string) {
		for (const l of this.getLeavesOfType(type)) l.detach();
	}

	async revealLeaf(leaf: WorkspaceLeaf) {
		const root = leaf.getRoot();
		if (root instanceof WorkspaceSidedock && root.collapsed) root.expand();
		leaf.parent?.selectTab(leaf);
		await leaf.loadIfDeferred();
	}

	getActiveViewOfType<T extends View>(type: abstract new (...args: any[]) => T): T | null {
		const view = this.activeLeaf?.view;
		return view instanceof type ? view : null;
	}

	// The active FileView's file; with a sidebar leaf active, the file of the
	// most recent main-area leaf. Never a file that was closed or deleted.
	getActiveFile(): TFile | null {
		const active = this.activeLeaf?.view;
		const view = active instanceof FileView ? active : this.getMostRecentLeaf()?.view;
		const file = view instanceof FileView ? view.file : null;
		return file && this.app.vault.getAbstractFileByPath(file.path) === file ? file : null;
	}

	#updateActiveFile() {
		if (this.#restoring) return;
		const file = this.getActiveFile();
		if (file === this.#activeFile) return;
		this.#activeFile = file;
		if (file) this.#lastOpenFiles = [file.path, ...this.#lastOpenFiles.filter((p) => p !== file.path)].slice(0, 10);
		this.trigger("file-open", file);
	}

	getLastOpenFiles() {
		return [...this.#lastOpenFiles];
	}

	#onRename(file: TAbstractFile, oldPath: string) {
		this.#retarget((p) => (p === oldPath ? file.path : p.startsWith(`${oldPath}/`) ? file.path + p.slice(oldPath.length) : p));
		this.requestUpdateLayout();
		this.requestSaveLayout();
	}

	#onDelete(file: TAbstractFile) {
		this.#retarget((p) => (p === file.path || p.startsWith(`${file.path}/`) ? null : p));
		this.#updateActiveFile();
		this.requestSaveLayout();
	}

	// The paths kept for later (recent files, closed tabs, leaf history)
	// follow a rename, and a deleted file's entries go, so reopening a tab or
	// going back never brings a file view back without its file.
	#retarget(map: (path: string) => string | null) {
		const follow = <T extends { state: ViewState }>(entries: T[]) =>
			entries.flatMap((entry) => {
				const path = entry.state.state?.file;
				if (typeof path !== "string") return [entry];
				const next = map(path);
				if (next === null) return [];
				return [next === path ? entry : { ...entry, state: { ...entry.state, state: { ...entry.state.state, file: next } } }];
			});
		this.#lastOpenFiles = this.#lastOpenFiles.map(map).filter((p): p is string => p !== null);
		this.#closed = follow(this.#closed);
		this.iterateAllLeaves((leaf) => {
			leaf.history.backHistory = follow(leaf.history.backHistory);
			leaf.history.forwardHistory = follow(leaf.history.forwardHistory);
		});
	}

	async openLinkText(linktext: string, sourcePath: string, newLeaf?: PaneType | boolean, openViewState?: OpenViewState) {
		const { path, subpath } = parseLinktext(linktext);
		let file = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		if (!file) file = await this.app.fileManager.createNewMarkdownFileFromLinktext(path, sourcePath);
		const leaf = this.getLeaf(newLeaf);
		// A new tab takes focus unless the user turned "Always focus new tabs" off.
		const active = openViewState?.active ?? (newLeaf ? this.app.vault.getConfig("focusNewTab") !== false : true);
		const eState = subpath ? { ...openViewState?.eState, subpath } : openViewState?.eState;
		await leaf.openFile(file, { ...openViewState, active, eState });
	}

	openPopoutLeaf(_data?: unknown) {
		// Stopgap until popout windows exist: a new tab in the main window.
		return this.getLeaf("tab");
	}

	moveLeafToPopout(_leaf: WorkspaceLeaf, _data?: unknown): WorkspaceWindow {
		throw new Error("Popout windows are not supported");
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

	getLayout() {
		return {
			main: this.rootSplit.serialize(),
			left: this.leftSplit.serialize(),
			right: this.rightSplit.serialize(),
			"left-ribbon": this.leftRibbon.serialize(),
			active: this.activeLeaf?.id,
			lastOpenFiles: this.getLastOpenFiles(),
		};
	}

	// Replaces the whole workspace with a layout in getLayout()'s shape.
	async changeLayout(layout: any) {
		const leaves: WorkspaceLeaf[] = [];
		this.iterateAllLeaves((l) => {
			leaves.push(l);
		});
		await Promise.allSettled(leaves.map((l) => l.view.close()));
		// Old leaves count as detached, so stale references cannot come back.
		for (const leaf of leaves) leaf.parent = null;
		this.activeLeaf = null;
		this.#restoring = true;
		try {
			await this.#restore(layout);
		} finally {
			this.#restoring = false;
		}
		const saved = typeof layout?.active === "string" ? this.getLeafById(layout.active) : null;
		const tabs = this.#rootTabs();
		const active = saved && this.isRootLeaf(saved) ? saved : tabs.children[tabs.currentTab];
		if (active) this.setActiveLeaf(active, { focus: true });
		this.onLayoutChange();
	}

	async #restore(layout: any) {
		const restore: [WorkspaceLeaf, LeafViewState][] = [];
		this.#load(this.rootSplit, layout?.main, restore);
		this.#load(this.leftSplit, layout?.left, restore);
		this.#load(this.rightSplit, layout?.right, restore);
		this.leftSplit.setWidth(typeof layout?.left?.width === "number" ? layout.left.width : 280);
		this.rightSplit.setWidth(typeof layout?.right?.width === "number" ? layout.right.width : 280);
		layout?.left?.collapsed ? this.leftSplit.collapse() : this.leftSplit.expand();
		layout?.right?.collapsed ? this.rightSplit.collapse() : this.rightSplit.expand();
		if (!tabGroups(this.rootSplit).some((t) => t.children.length)) this.getLeaf("tab");
		for (const dock of [this.leftSplit, this.rightSplit]) if (!dock.children.length) dock.insertChild(0, new WorkspaceTabs(this.app));
		this.leftRibbon.load(layout?.["left-ribbon"]);
		const recent: unknown[] = Array.isArray(layout?.lastOpenFiles) ? layout.lastOpenFiles : [];
		this.#lastOpenFiles = recent.filter((p): p is string => typeof p === "string" && !!this.app.vault.getAbstractFileByPath(p)).slice(0, 10);
		// A slow view (one that waits for a server) must not hold up startup;
		// it keeps loading after the wait.
		const loads = restore.map(([leaf, state]) => this.#reopen(leaf, state));
		await Promise.all(loads.map((load) => withTimeout(load, 3000)));
	}

	// Shows a saved view state again: a restored layout, a reopened tab, a
	// placeholder whose plugin came back. A file view whose file was deleted
	// or moved meanwhile (while justnotes was closed, or its plugin was off)
	// is dropped, as an open tab is when its file goes.
	async #reopen(leaf: WorkspaceLeaf, state: LeafViewState, eState?: any) {
		await replay(leaf, state, eState).catch((err) => console.error(err));
		const path = state.state?.file;
		if (showsNoFile(leaf.view) && !(typeof path === "string" && this.app.vault.getFileByPath(path))) leaf.detach();
	}

	#load(split: WorkspaceSplit, data: any, restore: [WorkspaceLeaf, LeafViewState][]) {
		for (const child of [...split.children]) {
			split.children.remove(child);
			child.parent = null;
			child.containerEl.detach();
		}
		if (typeof data?.id === "string") split.id = data.id;
		if (split === this.rootSplit && (data?.direction === "vertical" || data?.direction === "horizontal")) split.setDirection(data.direction);
		for (const c of Array.isArray(data?.children) ? data.children : []) {
			const item = this.#deserialize(c, restore);
			if (item instanceof WorkspaceTabs || item instanceof WorkspaceSplit) split.insertChild(split.children.length, item);
		}
	}

	#deserialize(data: any, restore: [WorkspaceLeaf, LeafViewState][]): WorkspaceItem | null {
		const id = typeof data?.id === "string" ? data.id : undefined;
		const children: any[] = Array.isArray(data?.children) ? data.children : [];
		let item: WorkspaceItem | null = null;
		if (data?.type === "leaf") {
			const leaf = new WorkspaceLeaf(this.app, id);
			if (typeof data.group === "string") leaf.setGroup(data.group);
			const state = typeof data.state?.type === "string" ? data.state : { type: "empty" };
			restore.push([leaf, { ...state, pinned: state.pinned ?? data.pinned }]);
			item = leaf;
		} else if (data?.type === "tabs") {
			const tabs = new WorkspaceTabs(this.app, id);
			for (const c of children) {
				const leaf = this.#deserialize(c, restore);
				if (leaf instanceof WorkspaceLeaf) tabs.insertChild(tabs.children.length, leaf);
			}
			if (!tabs.children.length) return null;
			tabs.selectTabIndex(Math.clamp(Number(data.currentTab) || 0, 0, tabs.children.length - 1));
			item = tabs;
		} else if (data?.type === "split") {
			const split = new WorkspaceSplit(this.app, data.direction === "horizontal" ? "horizontal" : "vertical", "", id);
			for (const c of children) {
				const child = this.#deserialize(c, restore);
				if (child instanceof WorkspaceTabs || child instanceof WorkspaceSplit) split.insertChild(split.children.length, child);
			}
			if (!split.children.length) return null;
			item = split;
		}
		if (item && typeof data.dimension === "number") item.setDimension(data.dimension);
		return item;
	}

	// Reopens the most recently closed main-area tab.
	async undoCloseLeaf() {
		const closed = this.#closed.pop();
		if (!closed) return false;
		const leaf = this.getLeaf("tab");
		await this.#reopen(leaf, closed.state, closed.eState);
		if (leaf.parent) this.setActiveLeaf(leaf, { focus: true });
		return true;
	}

	// Called before the window closes or reloads: saves open text views and the
	// layout, then gives plugins' 'quit' handlers a bounded time to finish.
	flushBeforeQuit(timeout = 5000) {
		this.#quitting ??= (async () => {
			const saves: Promise<unknown>[] = [];
			this.iterateAllLeaves((leaf) => {
				if (leaf.view instanceof TextFileView) saves.push(leaf.view.save());
			});
			await withTimeout(Promise.allSettled(saves), timeout);
			const tasks = new Tasks();
			this.trigger("quit", tasks);
			this.requestSaveLayout.cancel();
			if (this.layoutReady) this.app.saveLayoutState();
			await withTimeout(tasks.promise(), timeout);
		})().finally(() => (this.#quitting = null));
		return this.#quitting;
	}

	handleLinkClick(evt: MouseEvent, sourcePath: string, href: string) {
		const newLeaf = Keymap.isModEvent(evt);
		this.openLinkText(href, sourcePath, newLeaf);
	}

	// The internal-link context menu; returns whether the link resolves.
	handleLinkContextMenu(menu: Menu, linktext: string, sourcePath: string, leaf?: WorkspaceLeaf) {
		const file = this.app.metadataCache.getFirstLinkpathDest(parseLinktext(linktext).path, sourcePath);
		const open = (where: PaneType) => this.openLinkText(linktext, sourcePath, where);
		menu.addItem((i) => i.setSection("open").setTitle("Open in new tab").setIcon("file-plus").onClick(() => open("tab")));
		menu.addItem((i) => i.setSection("open").setTitle("Open to the right").setIcon("separator-vertical").onClick(() => open("split")));
		menu.addItem((i) => i.setSection("open").setTitle("Open in new window").setIcon("picture-in-picture-2").onClick(() => open("window")));
		if (file) this.trigger("file-menu", menu, file, "link-context-menu", leaf);
		return !!file;
	}

	// Page preview, Obsidian's core plugin: a rendered note in a popover for a
	// hovered internal link, with Mod held when the source asks for it.
	#onHoverLink(info: { event: MouseEvent; source: string; hoverParent: HoverParent; targetEl: HTMLElement | null; linktext: string; sourcePath?: string }) {
		const { event, source, hoverParent, targetEl, linktext } = info ?? {};
		if (!hoverParent || typeof linktext !== "string") return;
		if ((this.hoverLinkSources[source]?.defaultMod ?? true) && !Keymap.isModEvent(event)) return;
		const existing = hoverParent.hoverPopover;
		if (existing && existing.targetEl === targetEl && existing.state !== PopoverState.Hidden) return;
		const { path, subpath } = parseLinktext(linktext);
		const file = this.app.metadataCache.getFirstLinkpathDest(path, info.sourcePath ?? "");
		const image = file && /^(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(file.extension);
		if (!file || (file.extension !== "md" && !image)) return;
		const popover = new HoverPopover(hoverParent, targetEl);
		const content = popover.hoverEl.createDiv("markdown-embed is-loaded").createDiv("markdown-embed-content");
		if (image) {
			content.createEl("img", { attr: { src: this.app.vault.getResourcePath(file) } });
			return;
		}
		const preview = content.createDiv("markdown-preview-view");
		this.app.vault.cachedRead(file).then(
			(text) => {
				const range = subpathLines(this.app.metadataCache.getFileCache(file), subpath);
				const markdown = range ? text.split("\n").slice(range[0], range[1] + 1).join("\n") : text;
				return MarkdownRenderer.render(this.app, markdown, preview, file.path, popover);
			},
			(err) => console.error(err),
		);
	}

	// Leaves of a type that is not registered (yet) are placeholders; they come
	// alive when the type is registered and go back when it is unregistered.
	#watchViewRegistry() {
		const registry = this.app.viewRegistry;
		registry.on("view-registered", (type: string) => this.#onViewRegistered(type));
		registry.on("view-unregistered", (type: string) => this.#onViewUnregistered(type));
	}

	#onViewRegistered(type: string) {
		for (const leaf of this.getLeavesOfType(type)) {
			if (leaf.view instanceof PlaceholderView) this.#reopen(leaf, leaf.view.viewState);
		}
	}

	#onViewUnregistered(type: string) {
		for (const leaf of this.getLeavesOfType(type)) {
			if (leaf.view instanceof PlaceholderView) continue;
			const state = leaf.getViewState();
			leaf.open(new PlaceholderView(leaf, state)).then(
				() => this.onLeafViewChanged(leaf, true),
				(err) => console.error(err),
			);
		}
	}
}
