// Renders a settings tab from its Obsidian 1.13 setting definitions: groups,
// lists, rows (control, render, action, empty) and navigable pages.
import type { App } from "../app";
import { setIcon } from "../icons";
import type { SettingTab } from "../plugin";
import { type ExtraButtonComponent, SecretComponent, Setting, SettingGroup, SettingPage } from "./setting";
import { AbstractInputSuggest } from "./suggest";

type Predicate = boolean | (() => boolean);

export interface SettingControl {
	type: "toggle" | "dropdown" | "text" | "textarea" | "number" | "file" | "folder" | "slider" | "color" | "secret";
	key: string;
	defaultValue?: unknown;
	validate?: (value: any) => string | void | Promise<string | void>;
	disabled?: Predicate;
	options?: Record<string, string>;
	placeholder?: string;
	rows?: number;
	min?: number;
	max?: number;
	step?: number | "any";
	filter?: (file: any) => boolean;
	includeRoot?: boolean;
	displayFormat?: (value: number) => string;
}

export interface SettingDefinition {
	name: string;
	desc?: string | DocumentFragment;
	aliases?: string[];
	searchable?: Predicate;
	visible?: Predicate;
	control?: SettingControl;
	render?: (setting: Setting, group: SettingGroup) => void | (() => void);
	action?: (el: HTMLElement, index: number) => void;
	disabled?: Predicate;
}

export interface SettingDefinitionPage {
	type: "page";
	name: string;
	desc?: string | DocumentFragment;
	aliases?: string[];
	searchable?: Predicate;
	visible?: Predicate;
	displayValue?: string | (() => string);
	status?: "warning" | null | (() => "warning" | null);
	items?: SettingDefinitionItem[];
	page?: () => SettingPage;
}

export type SettingGroupItem = SettingDefinition | SettingDefinitionPage;

export interface SettingDefinitionGroup {
	type: "group" | "list";
	heading?: string;
	cls?: string;
	search?: { placeholder?: string; match: (def: SettingGroupItem, query: string) => boolean };
	extraButtons?: ((component: ExtraButtonComponent) => any)[];
	items?: SettingGroupItem[];
	visible?: Predicate;
	emptyState?: string | DocumentFragment;
	onReorder?: (oldIndex: number, newIndex: number) => void;
	onDelete?: (index: number) => void;
	addItem?: { name: string; action: (el: HTMLElement) => void };
}

export type SettingDefinitionItem = SettingGroupItem | SettingDefinitionGroup;

function isGroup(item: SettingDefinitionItem): item is SettingDefinitionGroup {
	return "type" in item && (item.type === "group" || item.type === "list");
}

function isPage(item: SettingDefinitionItem): item is SettingDefinitionPage {
	return "type" in item && item.type === "page";
}

// Plugins' predicates run on every render; one that throws counts as unset.
export function evaluate<T>(value: T | (() => T) | undefined, fallback: T): T {
	if (typeof value !== "function") return value ?? fallback;
	try {
		return (value as () => T)() ?? fallback;
	} catch (err) {
		console.error(err);
		return fallback;
	}
}

// A description or empty state given as a DocumentFragment is used up when it
// is rendered: its nodes move into the row. They are remembered, so a redraw
// from the same definitions moves them into the new row (keeping listeners
// and the plugin's references to them) and search still reads their text.
const fragmentNodes = new WeakMap<DocumentFragment, Node[]>();

function nodesOf(fragment: DocumentFragment) {
	let nodes = fragmentNodes.get(fragment);
	if (!nodes) fragmentNodes.set(fragment, (nodes = [...fragment.childNodes]));
	return nodes;
}

function renderable(content: string | DocumentFragment) {
	if (!(content instanceof DocumentFragment)) return content;
	const fragment = document.createDocumentFragment();
	fragment.append(...nodesOf(content));
	return fragment;
}

function textOf(content: string | DocumentFragment | undefined) {
	if (content === undefined || typeof content === "string") return content ?? "";
	return nodesOf(content).map((node) => node.textContent ?? "").join("");
}

// The page at a path of page names, looking inside groups at each level.
export function findPage(items: SettingDefinitionItem[], path: string[]): SettingDefinitionPage | null {
	let level = items;
	let page: SettingDefinitionPage | null = null;
	for (const name of path) {
		page = pagesIn(level).find((p) => p.name === name) ?? null;
		if (!page) return null;
		level = page.items ?? [];
	}
	return page;
}

function pagesIn(items: SettingDefinitionItem[]) {
	return items.flatMap((item) => (isGroup(item) ? (item.items ?? []) : [item])).filter(isPage);
}

export interface DefinitionMatch {
	name: string;
	pagePath: string[];
}

// Settings search: name, description text and aliases, skipping items that
// are hidden or not searchable, and descending into declarative pages.
export function searchDefinitions(items: SettingDefinitionItem[], query: string): DefinitionMatch[] {
	const q = query.trim().toLowerCase();
	const matches: DefinitionMatch[] = [];
	if (!q) return matches;
	const visit = (level: SettingDefinitionItem[], path: string[]) => {
		for (const item of level) {
			if (!evaluate(item.visible, true)) continue;
			if (isGroup(item)) {
				visit(item.items ?? [], path);
				continue;
			}
			if (!evaluate(item.searchable, true)) continue;
			if ([item.name, textOf(item.desc), ...(item.aliases ?? [])].some((text) => text.toLowerCase().includes(q))) {
				matches.push({ name: item.name, pagePath: path });
			}
			if (isPage(item) && item.items) visit(item.items, [...path, item.name]);
		}
	};
	visit(items, []);
	return matches;
}

interface Host {
	app: App;
	queries: Map<string, string>;
	getValue(key: string): unknown;
	setValue(key: string, value: unknown): void | Promise<void>;
	openPage(def: SettingDefinitionPage, path: string[]): void;
	refresh(): void;
}

// One rendered element whose visible/disabled predicates are re-evaluated in
// place by refreshDomState, without re-rendering.
interface DomState {
	el: HTMLElement;
	visible?: Predicate;
	filter?: () => boolean;
	disabled?: () => boolean;
	setDisabled?: (disabled: boolean) => void;
}

class DefinitionView {
	#host: Host;
	#containerEl: HTMLElement;
	#path: string[];
	#states: DomState[] = [];
	#cleanups: (() => void)[] = [];

	constructor(host: Host, containerEl: HTMLElement, path: string[]) {
		this.#host = host;
		this.#containerEl = containerEl;
		this.#path = path;
	}

	render(items: SettingDefinitionItem[]) {
		// Consecutive rows and pages outside a group share a headless group.
		let implicit: { group: SettingGroup; count: number } | null = null;
		items.forEach((item, i) => {
			if (isGroup(item)) {
				implicit = null;
				this.#renderGroup(item, String(i));
				return;
			}
			implicit ??= { group: new SettingGroup(this.#containerEl), count: 0 };
			this.#renderItem(implicit.group, item, implicit.count++, null);
		});
		this.refresh();
	}

	refresh() {
		for (const state of this.#states) {
			state.el.toggle(evaluate(state.visible, true) && (state.filter?.() ?? true));
			if (state.disabled) state.setDisabled?.(state.disabled());
		}
	}

	destroy() {
		for (const cleanup of this.#cleanups.splice(0)) {
			try {
				cleanup();
			} catch (err) {
				console.error(err);
			}
		}
		this.#states = [];
		this.#containerEl.empty();
	}

	#renderGroup(def: SettingDefinitionGroup, index: string) {
		const group = new SettingGroup(this.#containerEl);
		const list = def.type === "list" ? def : null;
		if (def.heading) group.setHeading(def.heading);
		if (def.cls) group.addClass(...def.cls.split(/\s+/));
		if (list) group.addClass("mod-list", "mod-no-icon");
		for (const button of def.extraButtons ?? []) group.addExtraButton(button);
		const addItem = list?.addItem;
		if (addItem) group.addExtraButton((b) => b.setIcon("plus").setTooltip(addItem.name).onClick(() => addItem.action(b.extraSettingsEl)));
		let filter: ((item: SettingGroupItem) => boolean) | undefined;
		const search = def.search;
		if (search) {
			const key = [...this.#path, def.heading ?? index].join("\n");
			const queries = this.#host.queries;
			group.addSearch((s) =>
				s
					.setPlaceholder(search.placeholder ?? "")
					.setValue(queries.get(key) ?? "")
					.onChange((query) => {
						queries.set(key, query);
						this.refresh();
					}),
			);
			filter = (item) => {
				const query = queries.get(key) ?? "";
				if (!query || !evaluate(item.searchable, true)) return true;
				return evaluate(() => search.match(item, query), true);
			};
		}
		const items = def.items ?? [];
		if (list && items.length === 0 && list.emptyState) {
			new Setting(group.listEl).setName(renderable(list.emptyState)).settingEl.addClass("mod-empty-state");
		}
		items.forEach((item, i) => this.#renderItem(group, item, i, list, filter && (() => filter(item))));
		this.#states.push({ el: group.containerEl, visible: def.visible });
	}

	#renderItem(group: SettingGroup, item: SettingGroupItem, index: number, list: SettingDefinitionGroup | null, filter?: () => boolean) {
		const setting = new Setting(group.listEl);
		const state: DomState = { el: setting.settingEl, visible: item.visible, filter };
		this.#states.push(state);
		if (list) setting.settingEl.insertBefore(createDiv("setting-item-icon"), setting.infoEl);
		try {
			setting.setName(item.name);
			if (item.desc !== undefined) setting.setDesc(renderable(item.desc));
			if (isPage(item)) this.#renderPageRow(setting, item);
			else this.#renderRow(setting, group, item, index, state);
		} catch (err) {
			console.error(`Setting "${item.name}" failed to render`, err);
		}
		if (list) this.#addListControls(setting, group, list, index);
	}

	#renderRow(setting: Setting, group: SettingGroup, def: SettingDefinition, index: number, state: DomState) {
		if (def.control) {
			const control = def.control;
			this.#renderControl(setting, control);
			state.disabled = () => evaluate(control.disabled, false);
			state.setDisabled = (disabled) => setting.setDisabled(disabled);
		} else if (def.render) {
			const cleanup = def.render(setting, group);
			if (typeof cleanup === "function") this.#cleanups.push(cleanup);
		} else if (def.action) {
			const action = def.action;
			const el = setting.settingEl;
			el.addClass("mod-action", "tappable");
			state.disabled = () => evaluate(def.disabled, false);
			state.setDisabled = (disabled) => el.toggleClass("is-disabled", disabled);
			onActivate(el, () => {
				if (!el.hasClass("is-disabled")) action(el, index);
			});
		}
	}

	#renderPageRow(setting: Setting, def: SettingDefinitionPage) {
		const el = setting.settingEl;
		el.addClass("mod-navigable", "tappable");
		if (def.displayValue !== undefined || def.status !== undefined) {
			setting.addDisplayValue((d) => d.setValue(evaluate(def.displayValue, "") || null).setStatus(evaluate(def.status, null)));
		}
		setIcon(setting.controlEl.createDiv("setting-item-chevron"), "chevron-right");
		onActivate(el, () => this.#host.openPage(def, [...this.#path, def.name]));
	}

	#renderControl(setting: Setting, control: SettingControl) {
		const host = this.#host;
		const stored = host.getValue(control.key);
		const value = stored === undefined || stored === null ? control.defaultValue : stored;
		const commit = async (next: unknown) => {
			try {
				const error = control.validate ? await control.validate(next) : undefined;
				setting.setErrorMessage(error || null);
				if (error) return;
				await host.setValue(control.key, next);
				host.refresh();
			} catch (err) {
				console.error(`Setting "${control.key}" failed to save`, err);
			}
		};
		const text = (v: unknown) => (v === undefined || v === null ? "" : String(v));
		switch (control.type) {
			case "toggle":
				setting.addToggle((t) => t.setValue(Boolean(value)).onChange(commit));
				break;
			case "dropdown":
				setting.addDropdown((d) => d.addOptions(control.options ?? {}).setValue(text(value)).onChange(commit));
				break;
			case "text":
				setting.addText((t) => t.setPlaceholder(control.placeholder ?? "").setValue(text(value)).onChange(commit));
				break;
			case "textarea":
				setting.addTextArea((t) => {
					if (control.rows) t.inputEl.rows = control.rows;
					t.setPlaceholder(control.placeholder ?? "").setValue(text(value)).onChange(commit);
				});
				break;
			case "number":
				setting.addText((t) => this.#numberInput(setting, t.inputEl, control, text(value), commit));
				break;
			case "file":
			case "folder":
				setting.addText((t) => {
					t.setPlaceholder(control.placeholder ?? "").setValue(text(value));
					new PathSuggest(host.app, t.inputEl, control).onSelect((path) => {
						t.setValue(path);
						commit(path);
					});
					t.inputEl.addEventListener("change", () => commit(t.getValue()));
				});
				break;
			case "slider":
				setting.addSlider((s) => {
					s.setLimits(control.min ?? 0, control.max ?? 100, control.step ?? 1).setValue(Number(value ?? control.min ?? 0));
					if (control.displayFormat) s.setDisplayFormat(control.displayFormat);
					s.onChange(commit);
				});
				break;
			case "color":
				setting.addColorPicker((c) => c.setValue(text(value) || "#000000").onChange(commit));
				break;
			case "secret":
				setting.addComponent((el) => new SecretComponent(host.app, el).setValue(text(value)).onChange((id) => commit(id ?? "")));
				break;
		}
		if (control.validate) {
			// Braces matter: a Setting has then(), so returning it would make
			// the promise adopt it and call then() forever.
			Promise.resolve(control.validate(value)).then((error) => {
				setting.setErrorMessage(error || null);
			}, console.error);
		}
	}

	// A number persists on Enter or when the field loses focus, falling back
	// to defaultValue (or 0) when the text is not a number, as in Obsidian.
	#numberInput(setting: Setting, input: HTMLInputElement, control: SettingControl, initial: string, commit: (v: unknown) => void) {
		input.type = "number";
		input.setAttr("inputmode", "decimal");
		if (control.placeholder) input.placeholder = control.placeholder;
		if (control.min !== undefined) input.min = String(control.min);
		if (control.max !== undefined) input.max = String(control.max);
		if (control.step !== undefined) input.step = String(control.step);
		input.value = initial;
		const parse = () => {
			const n = input.value.trim() === "" ? Number.NaN : Number(input.value);
			return Number.isFinite(n) ? n : typeof control.defaultValue === "number" ? control.defaultValue : 0;
		};
		const rangeError = (n: number) =>
			control.min !== undefined && n < control.min
				? `Value must be at least ${control.min}`
				: control.max !== undefined && n > control.max
					? `Value must be at most ${control.max}`
					: null;
		input.addEventListener("input", () => setting.setErrorMessage(rangeError(parse())));
		const submit = () => {
			const n = parse();
			const error = rangeError(n);
			setting.setErrorMessage(error);
			if (!error) commit(n);
		};
		input.addEventListener("change", submit);
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") submit();
		});
	}

	#addListControls(setting: Setting, group: SettingGroup, list: SettingDefinitionGroup, index: number) {
		const { onDelete, onReorder } = list;
		const el = setting.settingEl;
		if (onDelete) {
			setting.addExtraButton((b) => b.setIcon("x").setTooltip("Delete").onClick(() => onDelete(index)));
			el.addEventListener("keydown", (evt) => {
				if ((evt.key === "Delete" || evt.key === "Backspace") && evt.target === el) {
					evt.preventDefault();
					onDelete(index);
				}
			});
		}
		if (onReorder) {
			setting.addExtraButton((b) => {
				b.setIcon("menu").setTooltip("Drag to rearrange");
				b.extraSettingsEl.addClass("mod-drag-handle");
				b.extraSettingsEl.setAttr("tabindex", "-1");
				dragToReorder(b.extraSettingsEl, el, group.listEl, index, onReorder);
			});
		}
	}
}

// A row that does something when clicked or on Enter. Clicks on the row's own
// buttons, such as a list's delete button and drag handle, are theirs alone.
function onActivate(el: HTMLElement, run: () => void) {
	el.addEventListener("click", (evt) => {
		if (!(evt.target as Element).closest(".extra-setting-button")) run();
	});
	el.addEventListener("keydown", (evt) => {
		if (evt.key === "Enter" && evt.target === el) run();
	});
}

function dragToReorder(handle: HTMLElement, rowEl: HTMLElement, listEl: HTMLElement, from: number, onReorder: (from: number, to: number) => void) {
	const rows = () => [...listEl.children].filter((el) => el.hasClass("setting-item") && !el.hasClass("mod-empty-state"));
	handle.addEventListener("pointerdown", (evt) => {
		if (evt.button !== 0) return;
		evt.preventDefault();
		// The handle's own document: Settings may show in a popout window.
		const doc = handle.doc;
		rowEl.addClass("is-dragging");
		// The row moves live; the plugin is told once, on release.
		const move = (e: PointerEvent) => {
			const before = rows().find((r) => {
				if (r === rowEl) return false;
				const box = r.getBoundingClientRect();
				return e.clientY < box.top + box.height / 2;
			});
			listEl.insertBefore(rowEl, before ?? null);
		};
		const end = () => {
			doc.removeEventListener("pointermove", move);
			doc.removeEventListener("pointerup", end);
			doc.removeEventListener("pointercancel", end);
			rowEl.removeClass("is-dragging");
			const to = rows().indexOf(rowEl);
			if (to >= 0 && to !== from) onReorder(from, to);
		};
		doc.addEventListener("pointermove", move);
		doc.addEventListener("pointerup", end);
		doc.addEventListener("pointercancel", end);
	});
}

class PathSuggest extends AbstractInputSuggest<string> {
	#control: SettingControl;

	constructor(app: App, inputEl: HTMLInputElement, control: SettingControl) {
		super(app, inputEl);
		this.#control = control;
	}

	getSuggestions(query: string) {
		const { type, filter, includeRoot } = this.#control;
		const vault = this.app.vault;
		const entries = type === "file" ? vault.getFiles() : vault.getAllFolders(includeRoot);
		const q = query.toLowerCase();
		return entries
			.filter((entry) => !filter || evaluate(() => filter(entry), false))
			.map((entry) => entry.path)
			.filter((path) => path.toLowerCase().includes(q))
			.sort((a, b) => a.localeCompare(b));
	}

	renderSuggestion(path: string, el: HTMLElement) {
		el.setText(path);
	}

	selectSuggestion(path: string, evt: MouseEvent | KeyboardEvent) {
		super.selectSuggestion(path, evt);
		this.close();
	}
}

interface TabState {
	view: DefinitionView | null;
	pages: Set<DefinitionPage>;
	queries: Map<string, string>;
}

const tabStates = new WeakMap<SettingTab, TabState>();

function stateOf(tab: SettingTab) {
	let state = tabStates.get(tab);
	if (!state) tabStates.set(tab, (state = { view: null, pages: new Set(), queries: new Map() }));
	return state;
}

function hostOf(tab: SettingTab): Host {
	return {
		app: tab.app,
		queries: stateOf(tab).queries,
		getValue: (key) => tab.getControlValue(key),
		setValue: (key, value) => tab.setControlValue(key, value),
		openPage: (def, path) => openDefinitionPage(tab, def, path),
		refresh: () => refreshTab(tab),
	};
}

// A page declared with `items`, rendered from the tab's current definitions
// each time it is displayed, so update() reaches it as well.
class DefinitionPage extends SettingPage {
	#tab: SettingTab;
	#path: string[];
	#items: SettingDefinitionItem[];
	#view: DefinitionView | null = null;

	constructor(tab: SettingTab, def: SettingDefinitionPage, path: string[]) {
		super();
		this.#tab = tab;
		this.#path = path;
		this.#items = def.items ?? [];
		this.title = def.name;
	}

	display() {
		this.#view?.destroy();
		const items = findPage(this.#tab.settingItems, this.#path)?.items ?? this.#items;
		this.#view = new DefinitionView(hostOf(this.#tab), this.containerEl, this.#path);
		this.#view.render(items);
		stateOf(this.#tab).pages.add(this);
	}

	refresh() {
		this.#view?.refresh();
	}

	hide() {
		this.#view?.destroy();
		this.#view = null;
		stateOf(this.#tab).pages.delete(this);
		super.hide();
	}
}

export function openDefinitionPage(tab: SettingTab, def: SettingDefinitionPage, path: string[]) {
	const page = def.page ? def.page() : new DefinitionPage(tab, def, path);
	page.title ||= def.name;
	tab.app.setting.openPage(page);
}

// Definitions own the whole container, including what an earlier display() drew.
export function renderTab(tab: SettingTab) {
	teardownTab(tab);
	tab.containerEl.empty();
	const state = stateOf(tab);
	state.view = new DefinitionView(hostOf(tab), tab.containerEl, []);
	state.view.render(tab.settingItems);
}

export function teardownTab(tab: SettingTab) {
	const state = tabStates.get(tab);
	state?.view?.destroy();
	if (state) state.view = null;
}

export function refreshTab(tab: SettingTab) {
	const state = tabStates.get(tab);
	state?.view?.refresh();
	for (const page of state?.pages ?? []) page.refresh();
}

// After update(): redraw whatever of the tab is on screen.
export function tabUpdated(tab: SettingTab) {
	const state = tabStates.get(tab);
	if (!state) return;
	if (state.view) {
		if (tab.settingItems.length) renderTab(tab);
		else {
			teardownTab(tab);
			tab.display();
		}
	}
	for (const page of [...state.pages]) page.display();
}
