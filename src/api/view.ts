import type { App } from "./app";
import { Component, Events } from "./events";
import { setIcon, setTooltip } from "./icons";
import type { Scope } from "./keymap";
import { Menu } from "./ui/menu";
import { Notice } from "./ui/notice";
import { type Debouncer, debounce } from "./util";
import type { TAbstractFile, TFile } from "./vault";
import type { WorkspaceLeaf } from "./workspace";

export interface ViewState {
	type: string;
	state?: Record<string, any>;
	active?: boolean;
	pinned?: boolean;
	group?: WorkspaceLeaf;
}

export interface ViewStateResult {
	history: boolean;
}

// Open views by their containerEl, for focus tracking and resize events.
const viewByEl = new WeakMap<Element, View>();

function viewOf(node: EventTarget | null): View | null {
	for (let el = node instanceof Element ? node : node instanceof Node ? node.parentElement : null; el; el = el.parentElement) {
		const view = viewByEl.get(el);
		if (view) return view;
	}
	return null;
}

// A view's scope is active while keyboard focus is inside the view, under
// any modal or suggest scope pushed after it.
let focused: { view: View; scope: Scope } | null = null;

function focusView(view: View | null) {
	const scope = view?.scope ?? null;
	if (focused && focused.view === view && focused.scope === scope) return;
	if (focused) focused.view.app.keymap.popScope(focused.scope);
	focused = view && scope ? { view, scope } : null;
	if (focused) focused.view.app.keymap.pushScope(focused.scope);
}

if (typeof document !== "undefined") {
	document.addEventListener("focusin", (evt) => focusView(viewOf(evt.target)), true);
	document.addEventListener("focusout", (evt) => focusView(viewOf(evt.relatedTarget)), true);
	// A focused element that is hidden or removed fires no focusout. This runs
	// before the keymap's own capture listener (registered later, by App), so
	// every key goes to the scope of the view that really has focus.
	window.addEventListener("keydown", () => focusView(viewOf(document.activeElement)), true);
}

// One observer calls onResize for every open view whose size changed,
// including when it becomes visible. Calls wait for the next frame so view
// code that changes layout cannot loop the observer.
let resizeObserver: ResizeObserver | null = null;
const lastSize = new WeakMap<Element, string>();
const resized = new Set<View>();

function observeResize(view: View, observe: boolean) {
	resizeObserver ??= new ResizeObserver((entries) => {
		for (const { target, contentRect } of entries) {
			const view = viewByEl.get(target);
			const size = `${contentRect.width}x${contentRect.height}`;
			if (!view || contentRect.width === 0 || contentRect.height === 0 || lastSize.get(target) === size) continue;
			lastSize.set(target, size);
			if (resized.size === 0) requestAnimationFrame(flushResize);
			resized.add(view);
		}
	});
	if (observe) resizeObserver.observe(view.containerEl);
	else {
		resizeObserver.unobserve(view.containerEl);
		resized.delete(view);
	}
}

function flushResize() {
	const views = [...resized];
	resized.clear();
	for (const view of views) {
		try {
			view.onResize();
		} catch (err) {
			console.error(err);
		}
	}
}

export abstract class View extends Component {
	app: App;
	leaf: WorkspaceLeaf;
	containerEl: HTMLElement;
	scope: Scope | null = null;
	icon = "document";
	navigation = false;

	constructor(leaf: WorkspaceLeaf) {
		super();
		this.leaf = leaf;
		this.app = leaf.app;
		this.containerEl = createDiv("view-content-container workspace-leaf-content");
	}

	// The type is read here, not in the constructor: some getViewType()
	// implementations read fields a subclass constructor sets after super().
	async open(_parentEl: HTMLElement) {
		const type = this.getViewType();
		this.containerEl.setAttr("data-type", type);
		this.leaf.tabHeaderEl?.setAttr("data-type", type);
		viewByEl.set(this.containerEl, this);
		observeResize(this, true);
		this.load();
		await this.onOpen();
		if (this.containerEl.contains(document.activeElement)) focusView(this);
	}

	async close() {
		viewByEl.delete(this.containerEl);
		observeResize(this, false);
		if (focused?.view === this) focusView(null);
		await this.onClose();
		this.unload();
	}

	async onOpen() {}
	async onClose() {}

	abstract getViewType(): string;

	getState(): Record<string, any> {
		return {};
	}

	async setState(_state: any, _result: ViewStateResult) {}

	getEphemeralState(): Record<string, any> {
		return {};
	}

	// `focus` is how the workspace hands a newly active leaf the keyboard.
	setEphemeralState(state: any) {
		if (state?.focus && !this.containerEl.contains(document.activeElement)) {
			if (!this.containerEl.hasAttribute("tabindex")) this.containerEl.setAttr("tabindex", -1);
			this.containerEl.focus({ preventScroll: true });
		}
	}

	getIcon() {
		return this.icon;
	}

	onResize() {}

	getDisplayText() {
		return "";
	}

	onPaneMenu(_menu: Menu, _source: string) {}
}

export abstract class ItemView extends View {
	contentEl: HTMLElement;
	headerEl: HTMLElement;
	titleContainerEl: HTMLElement;
	titleParentEl: HTMLElement;
	titleEl: HTMLElement;
	actionsEl: HTMLElement;
	backButtonEl: HTMLButtonElement;
	forwardButtonEl: HTMLButtonElement;
	moreOptionsButtonEl: HTMLButtonElement;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.headerEl = this.containerEl.createDiv("view-header");
		const nav = this.headerEl.createDiv("view-header-left").createDiv("view-header-nav-buttons");
		this.backButtonEl = this.#navButton(nav, "arrow-left", "Navigate back", "back");
		this.forwardButtonEl = this.#navButton(nav, "arrow-right", "Navigate forward", "forward");
		this.titleContainerEl = this.headerEl.createDiv("view-header-title-container mod-at-start");
		this.titleParentEl = this.titleContainerEl.createDiv("view-header-title-parent");
		this.titleEl = this.titleContainerEl.createDiv("view-header-title");
		this.actionsEl = this.headerEl.createDiv("view-actions");
		this.moreOptionsButtonEl = this.actionsEl.createEl("button", { cls: "clickable-icon view-action mod-more-options" });
		setIcon(this.moreOptionsButtonEl, "more-vertical");
		setTooltip(this.moreOptionsButtonEl, "More options");
		this.moreOptionsButtonEl.addEventListener("click", () => this.#showMoreOptions());
		this.contentEl = this.containerEl.createDiv("view-content");
	}

	async open(parentEl: HTMLElement) {
		this.registerEvent(this.app.workspace.on("layout-change", () => this.#updateNavButtons()));
		this.#updateNavButtons();
		await super.open(parentEl);
	}

	// Actions are prepended, so the newest is leftmost and More options stays last.
	addAction(icon: string, title: string, callback: (evt: MouseEvent) => any) {
		const el = createEl("button", { cls: "clickable-icon view-action" });
		setIcon(el, icon);
		setTooltip(el, title);
		el.addEventListener("click", callback);
		this.actionsEl.prepend(el);
		return el;
	}

	#navButton(parent: HTMLElement, icon: string, title: string, direction: "back" | "forward") {
		const el = parent.createEl("button", { cls: "clickable-icon" });
		setIcon(el, icon);
		setTooltip(el, title);
		// Leaf history belongs to the workspace; the buttons only call into it.
		el.addEventListener("click", () => (this.leaf.history as { back?(): unknown; forward?(): unknown } | undefined)?.[direction]?.());
		return el;
	}

	#updateNavButtons() {
		const history = this.leaf.history as { backHistory?: unknown[]; forwardHistory?: unknown[] } | undefined;
		this.backButtonEl.toggleClass("mod-active", !!history?.backHistory?.length);
		this.forwardButtonEl.toggleClass("mod-active", !!history?.forwardHistory?.length);
	}

	#showMoreOptions() {
		const menu = new Menu();
		this.onPaneMenu(menu, "more-options");
		menu.addItem((i) =>
			i
				.setTitle("Close")
				.setIcon("x")
				.setSection("close")
				.onClick(() => this.leaf.detach()),
		);
		const r = this.moreOptionsButtonEl.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.bottom });
	}
}

export abstract class FileView extends ItemView {
	file: TFile | null = null;
	allowNoFile = false;
	navigation = true;
	// The path this view last showed for its file: the vault renames TFiles in
	// place, so a changed path is how a rename of the file or a parent folder shows.
	#path: string | null = null;

	onload() {
		this.registerEvent(this.app.vault.on("rename", () => this.#onRename()));
		this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => this.#onDelete(file)));
	}

	getDisplayText() {
		return this.file?.basename ?? "No file";
	}

	canAcceptExtension(_extension: string) {
		return false;
	}

	getState(): Record<string, any> {
		return { file: this.file?.path ?? null };
	}

	async setState(state: any, _result: ViewStateResult) {
		const file = state?.file ? this.app.vault.getFileByPath(state.file) : null;
		if (file && file !== this.file) await this.loadFile(file);
	}

	async loadFile(file: TFile) {
		if (this.file) await this.onUnloadFile(this.file);
		this.file = file;
		this.#path = file.path;
		this.titleEl.setText(this.getDisplayText());
		await this.onLoadFile(file);
		this.leaf.updateHeader();
	}

	async onLoadFile(_file: TFile) {}
	async onUnloadFile(_file: TFile) {}

	async onRename(_file: TFile) {
		this.titleEl.setText(this.getDisplayText());
		this.leaf.updateHeader();
		this.app.workspace.requestSaveLayout();
	}

	onPaneMenu(menu: Menu, source: string) {
		super.onPaneMenu(menu, source);
		if (this.file) this.app.workspace.trigger("file-menu", menu, this.file, source, this.leaf);
	}

	// The file unloads (and saves) before onClose, so a subclass whose onClose
	// skips super, or tears down its editor first, still saves.
	async close() {
		const file = this.file;
		try {
			if (file) await this.onUnloadFile(file);
		} catch (err) {
			console.error(err);
			new Notice(`Could not save ${file?.path}: ${err instanceof Error ? err.message : err}`);
		}
		await super.close();
	}

	#onRename() {
		const file = this.file;
		if (!file || file.path === this.#path) return;
		this.#path = file.path;
		this.onRename(file).catch((err) => console.error(err));
	}

	// The file is gone when it, or a folder above it, was deleted. The view
	// closes without writing it back, unless it can live without a file.
	async #onDelete(deleted: TAbstractFile) {
		const file = this.file;
		if (!file || (deleted !== file && this.app.vault.getAbstractFileByPath(file.path) === file)) return;
		try {
			await this.onUnloadFile(file);
		} catch (err) {
			console.error(err);
		}
		if (this.file !== file) return;
		this.file = null;
		this.#path = null;
		if (this.allowNoFile) {
			this.titleEl.setText(this.getDisplayText());
			this.leaf.updateHeader();
		} else this.leaf.detach();
	}
}

export abstract class EditableFileView extends FileView {}

// A text file view keeps three copies of the text apart: the view's own
// (getViewData), `data` (Obsidian's in-memory copy: the text last loaded,
// saved or reloaded), and what this view last read from or wrote to the file,
// which is the base when changes made elsewhere meet unsaved edits.
export abstract class TextFileView extends EditableFileView {
	data = "";
	// Set by requestSave; cleared once save() takes the text to write.
	dirty = false;
	requestSave: Debouncer<[], Promise<void> | void>;
	#disk: { file: TFile; text: string } | null = null;
	#loading = false;
	// Texts this view is writing (or wrote within the last second): their
	// modify events are its own.
	#writes = new Map<string, number>();
	#writing: Promise<unknown> = Promise.resolve();

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		const later = debounce(() => this.save(), 2000, true);
		const request = (() => {
			this.dirty = true;
			later();
			return request;
		}) as Debouncer<[], Promise<void> | void>;
		request.cancel = () => {
			later.cancel();
			return request;
		};
		request.run = () => later.run();
		this.requestSave = request;
	}

	onload() {
		super.onload();
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file === this.file) this.#onModify(this.file).catch((err) => console.error(err));
			}),
		);
	}

	async loadFile(file: TFile) {
		this.#loading = true;
		try {
			await super.loadFile(file);
		} finally {
			this.#loading = false;
		}
	}

	async onLoadFile(file: TFile) {
		const text = await this.app.vault.read(file);
		this.data = text;
		this.#disk = { file, text };
		this.dirty = false;
		this.setViewData(text, true);
	}

	// Saves any unsaved changes first; save(true) then clears the view.
	async onUnloadFile(_file: TFile) {
		await this.save(true);
		this.#disk = null;
	}

	// Writes when there are unsaved changes, never to a file the vault no
	// longer has (a deleted file must not come back from a pending save).
	async save(clear?: boolean) {
		this.requestSave.cancel();
		const file = this.file;
		if (file && this.app.vault.getAbstractFileByPath(file.path) === file) {
			const data = this.getViewData();
			if (this.dirty || data !== this.data) {
				this.dirty = false;
				this.data = data;
				this.#disk = { file, text: data };
				await this.#write(file, data);
			}
		}
		if (clear) this.clear();
	}

	// Writes run one at a time, in the order save() was called, so the file
	// ends up with the newest text; a queued write skips a file deleted meanwhile.
	async #write(file: TFile, data: string) {
		this.#writes.set(data, (this.#writes.get(data) ?? 0) + 1);
		const run = this.#writing.then(() => {
			if (this.app.vault.getAbstractFileByPath(file.path) === file) return this.app.vault.modify(file, data);
		});
		this.#writing = run.catch(() => {});
		try {
			await run;
		} catch (err) {
			this.dirty = true;
			throw err;
		} finally {
			setTimeout(() => {
				const n = (this.#writes.get(data) ?? 1) - 1;
				if (n > 0) this.#writes.set(data, n);
				else this.#writes.delete(data);
			}, 1000);
		}
	}

	// The file changed outside this view (another pane, a plugin, git, the
	// disk). Without unsaved edits the view takes the new text. With them, the
	// edits are merged into it line by line, so neither side is lost; lines
	// both sides changed differently keep the file's version, then the view's.
	async #onModify(file: TFile) {
		if (this.#loading) return;
		const text = await this.app.vault.read(file);
		if (this.#loading || file !== this.file || this.#writes.has(text)) return;
		const base = this.#disk?.file === file ? this.#disk.text : this.data;
		if (text === base) return;
		this.#disk = { file, text };
		const ours = this.getViewData();
		const merge = !this.dirty && ours === this.data ? { text, conflicts: 0 } : mergeText(base, ours, text);
		this.data = merge.text;
		if (merge.text !== ours) this.setViewData(merge.text, false);
		// Applying the text can look like an edit to the view; it is saved
		// only when the merge kept edits the file does not have.
		if (merge.text === text) {
			this.requestSave.cancel();
			this.dirty = false;
		} else this.requestSave();
		if (merge.conflicts) {
			new Notice(`${file.name} changed on disk while it had unsaved edits. Lines changed on both sides now appear twice: the file's version, then yours.`, 10000);
		}
	}

	abstract getViewData(): string;
	abstract setViewData(data: string, clear: boolean): void;
	abstract clear(): void;
}

export interface ViewCreator {
	(leaf: WorkspaceLeaf): View;
}

// Triggers "view-registered" and "view-unregistered" (with the type) and
// "extensions-updated", so leaves of a type can come alive when it registers.
export class ViewRegistry extends Events {
	viewByType: Record<string, ViewCreator> = {};
	typeByExtension: Record<string, string> = {};

	registerView(type: string, creator: ViewCreator) {
		if (this.viewByType[type]) throw new Error(`Attempting to register an existing view type "${type}"`);
		this.viewByType[type] = creator;
		this.trigger("view-registered", type);
	}

	unregisterView(type: string) {
		if (!this.viewByType[type]) return;
		delete this.viewByType[type];
		this.trigger("view-unregistered", type);
	}

	registerExtensions(extensions: string[], type: string) {
		for (const ext of extensions) this.typeByExtension[ext] = type;
		this.trigger("extensions-updated");
	}

	unregisterExtensions(extensions: string[]) {
		for (const ext of extensions) delete this.typeByExtension[ext];
		this.trigger("extensions-updated");
	}

	registerViewWithExtensions(extensions: string[], type: string, creator: ViewCreator) {
		this.registerView(type, creator);
		this.registerExtensions(extensions, type);
	}

	getTypeByExtension(ext: string) {
		return this.typeByExtension[ext];
	}

	isExtensionRegistered(ext: string) {
		return ext in this.typeByExtension;
	}

	getViewCreatorByType(type: string) {
		return this.viewByType[type];
	}
}

// Line pairs (i, j) with a[i] === b[j] forming a longest common subsequence,
// in increasing order (Myers' O(ND) diff on the lines between the common
// prefix and suffix). A huge difference gives up on the middle and matches
// only the prefix and suffix, which callers treat as one changed block.
export function matchLines(a: string[], b: string[], budget = 1e7): [number, number][] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const pairs: [number, number][] = [];
	for (let i = 0; i < start; i++) pairs.push([i, i]);
	const n = endA - start;
	const m = endB - start;
	const max = n + m;
	const trace: Int32Array[] = [];
	let v = new Int32Array(2 * max + 2);
	let found = n === 0 || m === 0;
	for (let d = 0; !found && d <= max && (d + 1) * v.length <= budget; d++) {
		const next = v.slice();
		for (let k = -d; k <= d; k += 2) {
			const down = k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max]);
			let x = down ? v[k + 1 + max] : v[k - 1 + max] + 1;
			let y = x - k;
			while (x < n && y < m && a[start + x] === b[start + y]) {
				x++;
				y++;
			}
			next[k + max] = x;
			if (x >= n && y >= m) {
				found = true;
				break;
			}
		}
		trace.push(v);
		v = next;
	}
	if (found && n > 0 && m > 0) {
		const middle: [number, number][] = [];
		let x = n;
		let y = m;
		for (let d = trace.length - 1; d > 0; d--) {
			const prev = trace[d];
			const k = x - y;
			const down = k === -d || (k !== d && prev[k - 1 + max] < prev[k + 1 + max]);
			const prevK = down ? k + 1 : k - 1;
			const prevX = prev[prevK + max];
			const startX = down ? prevX : prevX + 1;
			while (x > startX && y > startX - k) middle.push([start + --x, start + --y]);
			x = prevX;
			y = prevX - prevK;
		}
		while (x > 0 && y > 0) middle.push([start + --x, start + --y]);
		pairs.push(...middle.reverse());
	}
	for (let i = endA; i < a.length; i++) pairs.push([i, endB + i - endA]);
	return pairs;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

// A three-way line merge (diff3) of two edits of `base`. Changes on one side,
// or the same change on both, merge cleanly. Where the sides changed the same
// lines differently, both versions are kept, `theirs` first, and the region
// counts as a conflict.
export function mergeText(base: string, ours: string, theirs: string): { text: string; conflicts: number } {
	if (ours === base || ours === theirs) return { text: theirs, conflicts: 0 };
	if (theirs === base) return { text: ours, conflicts: 0 };
	const o = base.split("\n");
	const a = ours.split("\n");
	const b = theirs.split("\n");
	const inA = new Int32Array(o.length).fill(-1);
	const inB = new Int32Array(o.length).fill(-1);
	for (const [i, j] of matchLines(o, a)) inA[i] = j;
	for (const [i, j] of matchLines(o, b)) inB[i] = j;
	const out: string[] = [];
	let conflicts = 0;
	let i = 0;
	let ia = 0;
	let ib = 0;
	const chunk = (endO: number, endA: number, endB: number) => {
		const os = o.slice(i, endO);
		const as = a.slice(ia, endA);
		const bs = b.slice(ib, endB);
		if (sameLines(as, os)) out.push(...bs);
		else if (sameLines(bs, os) || sameLines(as, bs)) out.push(...as);
		else {
			let head = 0;
			while (head < as.length && head < bs.length && as[head] === bs[head]) head++;
			let tail = 0;
			while (tail < as.length - head && tail < bs.length - head && as[as.length - 1 - tail] === bs[bs.length - 1 - tail]) tail++;
			out.push(...bs.slice(0, bs.length - tail), ...as.slice(head));
			conflicts++;
		}
		i = endO;
		ia = endA;
		ib = endB;
	};
	for (;;) {
		while (i < o.length && inA[i] === ia && inB[i] === ib) {
			out.push(o[i]);
			i++;
			ia++;
			ib++;
		}
		let j = i;
		while (j < o.length && (inA[j] < 0 || inB[j] < 0)) j++;
		if (j < o.length) chunk(j, inA[j], inB[j]);
		else {
			if (i < o.length || ia < a.length || ib < b.length) chunk(o.length, a.length, b.length);
			break;
		}
	}
	return { text: out.join("\n"), conflicts };
}

export interface TextChange {
	from: number;
	to: number;
	insert: string;
}

// The edits that turn `prev` into `next`, in `prev` offsets and ascending
// order: one per changed run of lines, trimmed to the characters that
// differ, so positions outside the changes keep their place.
export function textChanges(prev: string, next: string): TextChange[] {
	if (prev === next) return [];
	const a = prev.split("\n");
	const b = next.split("\n");
	const starts = [0];
	for (const line of a) starts.push(starts[starts.length - 1] + line.length + 1);
	const changes: TextChange[] = [];
	const add = (from: number, to: number, insert: string) => {
		let head = 0;
		const removed = prev.slice(from, to);
		while (head < removed.length && head < insert.length && removed[head] === insert[head]) head++;
		let tail = 0;
		while (tail < removed.length - head && tail < insert.length - head && removed[removed.length - 1 - tail] === insert[insert.length - 1 - tail]) tail++;
		changes.push({ from: from + head, to: to - tail, insert: insert.slice(head, insert.length - tail) });
	};
	let ia = 0;
	let ib = 0;
	for (const [i, j] of [...matchLines(a, b), [a.length, b.length] as [number, number]]) {
		if (i > ia || j > ib) {
			const lines = b.slice(ib, j);
			if (i < a.length) add(starts[ia], starts[i], lines.map((l) => `${l}\n`).join(""));
			else if (ia > 0) add(starts[ia] - 1, prev.length, lines.map((l) => `\n${l}`).join(""));
			else add(0, prev.length, lines.join("\n"));
		}
		ia = i + 1;
		ib = j + 1;
	}
	return changes;
}
