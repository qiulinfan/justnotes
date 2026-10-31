// The built-in table: one row per entry, a section per group, a summary row,
// and note properties edited in place.
import { setIcon } from "../icons";
import { Menu } from "../ui/menu";
import { BatchRenderer } from "./batches";
import { summariesOf, viewData } from "./config";
import type { QueryController } from "./controller";
import type { BasesEntry } from "./entry";
import { frontmatterOf } from "./file-fields";
import { propertyType } from "./frontmatter";
import { type BasesPropertyId, parsePropertyId } from "./property";
import { BUILT_IN_SUMMARIES } from "./query";
import { BooleanValue, NullValue, NumberValue, renderContextOf, renderInternalLink, type Value } from "./values";
import { BasesView, type BasesViewRegistration } from "./view";

const LIST_TYPES = ["multitext", "tags", "aliases"];
const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 });

// The frontmatter key a property name refers to: exact, then ignoring case.
export function frontmatterKey(fm: Record<string, unknown>, name: string) {
	if (Object.hasOwn(fm, name)) return name;
	const lower = name.toLowerCase();
	return Object.keys(fm).find((k) => k.toLowerCase() === lower) ?? name;
}

export function renderFileLink(view: BasesView, el: HTMLElement, entry: BasesEntry) {
	const file = entry.file;
	renderInternalLink(view.app, el, file.path, "", file.extension === "md" ? file.basename : file.name, true, renderContextOf(view.app));
}

// Summary numbers are rounded for display only.
export function renderSummary(el: HTMLElement, value: Value) {
	if (value instanceof NumberValue && !Number.isInteger(value.value)) el.setText(numberFormat.format(value.value));
	else value.renderTo(el);
}

export class TableView extends BasesView {
	type = "table";
	#controller: QueryController;
	#el: HTMLElement;
	#batches = new BatchRenderer();
	#entries = new Map<string, BasesEntry>();
	// Note properties shown as checkboxes, empty ones included: those typed
	// checkbox, or holding a boolean in any row.
	#checkboxes = new Set<BasesPropertyId>();

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.#controller = controller;
		this.#el = containerEl.createDiv("bases-table-container");
	}

	onunload() {
		this.#batches.stop();
		this.#el.detach();
	}

	#columns(): BasesPropertyId[] {
		const order = this.config.getOrder();
		return order.length ? order : ["file.name"];
	}

	onDataUpdated() {
		const scrollTop = this.#el.scrollTop;
		const scrollLeft = this.#el.scrollLeft;
		this.#el.empty();
		this.#entries.clear();
		const columns = this.#columns();
		this.#checkboxes = new Set(
			columns.filter((id) => {
				const { type, name } = parsePropertyId(id);
				return type === "note" && (propertyType(this.app, name) === "checkbox" || this.data.data.some((e) => e.getValue(id) instanceof BooleanValue));
			}),
		);
		const sizes = (this.config.get("columnSize") ?? {}) as Record<string, number>;
		const rowHeight = String(this.config.get("rowHeight") ?? "short").replace(/[^\w-]/g, "");
		const table = this.#el.createEl("table", `bases-table mod-row-${rowHeight}`);
		const colgroup = table.createEl("colgroup");
		for (const id of columns) {
			const col = colgroup.createEl("col");
			if (Number(sizes[id]) > 0) col.style.width = `${Number(sizes[id])}px`;
		}
		this.#header(table.createEl("thead").createEl("tr"), columns, colgroup);
		this.#listen(table);

		const groups = this.data.groupedData;
		const grouped = groups.some((g) => g.key !== undefined);
		const summaries = summariesOf(this.config);
		const tasks: (() => void)[] = [];
		for (const group of groups) {
			let body: HTMLElement | null = null;
			const section = () => (body ??= table.createEl("tbody", "bases-group"));
			if (grouped) {
				tasks.push(() => {
					const cell = section().createEl("tr", "bases-group-heading").createEl("td", { attr: { colspan: columns.length } });
					const key = cell.createSpan("bases-group-value");
					if (group.hasKey()) group.key!.renderTo(key, renderContextOf(this.app));
					else key.setText("No value");
					cell.createSpan({ cls: "bases-group-count", text: String(group.entries.length) });
					// A grouped table shows each group's summary at its top.
					if (summaries.size) this.#summaryRow(section(), group.entries, columns, summaries);
				});
			}
			for (const entry of group.entries) tasks.push(() => this.#row(section(), entry, columns));
		}
		if (!this.data.data.length) {
			table.createEl("tbody").createEl("tr", "bases-empty").createEl("td", { text: "No results", attr: { colspan: columns.length } });
		}
		if (!grouped && summaries.size) this.#summaryRow(table.createEl("tfoot"), this.data.data, columns, summaries);
		this.#batches.render(this.#el, tasks, scrollTop);
		this.#el.scrollLeft = scrollLeft;
	}

	#header(tr: HTMLElement, columns: BasesPropertyId[], colgroup: HTMLElement) {
		const sorts = this.config.getSort();
		columns.forEach((id, i) => {
			const th = tr.createEl("th", { cls: "bases-th", attr: { "data-property": id } });
			th.createSpan({ cls: "bases-th-label", text: this.config.getDisplayName(id) });
			const sort = sorts.find((s) => s.property === id);
			if (sort) setIcon(th.createSpan("bases-th-sort"), sort.direction === "ASC" ? "arrow-up" : "arrow-down");
			th.addEventListener("click", (evt) => this.#columnMenu(evt, id));
			const handle = th.createDiv("bases-th-resize");
			handle.addEventListener("click", (evt) => evt.stopPropagation());
			handle.addEventListener("mousedown", (evt) => this.#resize(evt, id, th, colgroup.children[i] as HTMLElement));
		});
	}

	// Dragging a header's edge sets the column's width in `columnSize`.
	#resize(evt: MouseEvent, id: BasesPropertyId, th: HTMLElement, col: HTMLElement) {
		evt.preventDefault();
		evt.stopPropagation();
		const start = evt.clientX;
		const width = th.getBoundingClientRect().width;
		const move = (e: MouseEvent) => (col.style.width = `${Math.max(40, width + e.clientX - start)}px`);
		const up = (e: MouseEvent) => {
			document.removeEventListener("mousemove", move);
			document.removeEventListener("mouseup", up);
			const sizes = { ...((this.config.get("columnSize") ?? {}) as Record<string, number>) };
			sizes[id] = Math.round(Math.max(40, width + e.clientX - start));
			this.config.set("columnSize", sizes);
		};
		document.addEventListener("mousemove", move);
		document.addEventListener("mouseup", up);
	}

	#set(key: string, value: unknown) {
		this.config.set(key, value);
		this.#controller.run();
	}

	#columnMenu(evt: MouseEvent, id: BasesPropertyId) {
		const order = this.#columns();
		const sorts = this.config.getSort().filter((s) => s.property !== id);
		const i = order.indexOf(id);
		const move = (to: number) => {
			const next = [...order];
			next.splice(i, 1);
			next.splice(to, 0, id);
			this.#set("order", next);
		};
		const menu = new Menu();
		menu.addItem((item) => item.setTitle("Sort ascending").setIcon("arrow-up").setSection("sort").onClick(() => this.#set("sort", [{ property: id, direction: "ASC" }, ...sorts])));
		menu.addItem((item) => item.setTitle("Sort descending").setIcon("arrow-down").setSection("sort").onClick(() => this.#set("sort", [{ property: id, direction: "DESC" }, ...sorts])));
		menu.addItem((item) => {
			item.setTitle("Summarize").setIcon("sigma").setSection("summary");
			this.#summaryChoices(item.setSubmenu(), id);
		});
		if (i > 0) menu.addItem((item) => item.setTitle("Move left").setIcon("arrow-left").setSection("move").onClick(() => move(i - 1)));
		if (i >= 0 && i < order.length - 1) menu.addItem((item) => item.setTitle("Move right").setIcon("arrow-right").setSection("move").onClick(() => move(i + 1)));
		menu.addItem((item) => item.setTitle("Hide property").setIcon("eye-off").setSection("move").onClick(() => this.#set("order", order.filter((p) => p !== id))));
		menu.showAtMouseEvent(evt);
	}

	#summaryChoices(menu: Menu, id: BasesPropertyId) {
		const current = summariesOf(this.config).get(id);
		const write = (name: string | null) => {
			const summaries = { ...((viewData(this.config).summaries ?? {}) as Record<string, string>) };
			for (const key of Object.keys(summaries)) if (key === id || `note.${key}` === id) delete summaries[key];
			if (name) summaries[id] = name;
			this.#set("summaries", Object.keys(summaries).length ? summaries : null);
		};
		menu.addItem((x) => x.setTitle("None").setChecked(!current).onClick(() => write(null)));
		const custom = Object.keys(this.#controller.document.config.summaries ?? {});
		for (const name of [...BUILT_IN_SUMMARIES, ...custom]) menu.addItem((x) => x.setTitle(name).setChecked(current === name).onClick(() => write(name)));
	}

	#summaryRow(parent: HTMLElement, entries: BasesEntry[], columns: BasesPropertyId[], summaries: Map<BasesPropertyId, string>) {
		const tr = parent.createEl("tr", "bases-summary-row");
		for (const id of columns) {
			const td = tr.createEl("td", "bases-summary-cell");
			const name = summaries.get(id);
			if (name) {
				td.createSpan({ cls: "bases-summary-label", text: name });
				renderSummary(td.createSpan("bases-summary-value"), this.data.getSummaryValue(this.#controller, entries, id, name));
			}
			td.addEventListener("click", (evt) => {
				const menu = new Menu();
				this.#summaryChoices(menu, id);
				menu.showAtMouseEvent(evt);
			});
		}
	}

	#row(body: HTMLElement, entry: BasesEntry, columns: BasesPropertyId[]) {
		this.#entries.set(entry.file.path, entry);
		const tr = body.createEl("tr", { cls: "bases-tr", attr: { "data-path": entry.file.path } });
		for (const id of columns) this.#cell(tr.createEl("td", { cls: "bases-td", attr: { "data-property": id } }), entry, id);
	}

	#cell(td: HTMLElement, entry: BasesEntry, id: BasesPropertyId) {
		if (id === "file.name") return renderFileLink(this, td, entry);
		const value = entry.getValue(id) ?? NullValue.value;
		const editable = parsePropertyId(id).type === "note" && entry.file.extension === "md";
		if (editable && (value instanceof BooleanValue || (value instanceof NullValue && this.#checkboxes.has(id)))) {
			const box = td.createEl("input", { type: "checkbox", cls: "metadata-input-checkbox bases-cell-checkbox" });
			box.checked = value instanceof BooleanValue && value.value;
			return;
		}
		td.toggleClass("is-editable", editable);
		value.renderTo(td, renderContextOf(this.app));
	}

	// Edits go to the note's frontmatter; the metadata cache then reruns the base.
	#listen(table: HTMLElement) {
		const target = (evt: Event) => {
			const td = (evt.target as HTMLElement).closest<HTMLElement>("td.bases-td");
			const path = td?.parentElement?.getAttribute("data-path");
			const entry = path ? this.#entries.get(path) : undefined;
			const id = td?.getAttribute("data-property") as BasesPropertyId | null;
			return td && entry && id ? { td, entry, name: parsePropertyId(id).name } : null;
		};
		table.addEventListener("change", (evt) => {
			const hit = target(evt);
			const box = evt.target as HTMLInputElement;
			if (!hit || !box.matches(".bases-cell-checkbox")) return;
			this.app.fileManager.processFrontMatter(hit.entry.file, (fm) => {
				fm[frontmatterKey(fm, hit.name)] = box.checked;
			});
		});
		table.addEventListener("dblclick", (evt) => {
			const hit = target(evt);
			if (hit?.td.hasClass("is-editable") && !(evt.target as HTMLElement).closest("a")) this.#edit(hit.td, hit.entry, hit.name);
		});
	}

	#edit(td: HTMLElement, entry: BasesEntry, name: string) {
		if (td.querySelector("input")) return;
		const fm = frontmatterOf(this.app, entry.file) ?? {};
		const key = frontmatterKey(fm, name);
		const raw = fm[key];
		const list = Array.isArray(raw) || LIST_TYPES.includes(propertyType(this.app, key) ?? "");
		const numeric = typeof raw === "number" || propertyType(this.app, key) === "number";
		const original = raw === null || raw === undefined ? "" : list ? (Array.isArray(raw) ? raw : [raw]).join(", ") : String(raw);
		td.empty();
		const input = td.createEl("input", { type: "text", cls: "bases-cell-input", value: original });
		input.focus();
		input.select();
		let done = false;
		const finish = (save: boolean) => {
			if (done) return;
			done = true;
			const text = input.value.trim();
			td.empty();
			if (!save || text === original.trim()) {
				this.#cell(td, entry, `note.${name}`);
				return;
			}
			td.setText(text);
			this.app.fileManager.processFrontMatter(entry.file, (data) => {
				if (!text) delete data[key];
				else if (list) data[key] = text.split(",").map((s) => s.trim()).filter(Boolean);
				else data[key] = numeric && Number.isFinite(Number(text)) ? Number(text) : text;
			});
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				finish(true);
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				finish(false);
			}
		});
		input.addEventListener("blur", () => finish(true));
	}
}

export const TABLE_VIEW: BasesViewRegistration = {
	name: "Table",
	icon: "table",
	factory: (controller, containerEl) => new TableView(controller, containerEl),
	options: () => [
		{ type: "dropdown", key: "rowHeight", displayName: "Row height", default: "short", options: { short: "Short", medium: "Medium", tall: "Tall", "extra-tall": "Extra tall" } },
	],
};
