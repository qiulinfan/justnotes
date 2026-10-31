// The Bases toolbar: view picker, result count, sort, group, filters,
// properties and new note. Every change is written to the view's YAML.
import { setIcon, setTooltip } from "../icons";
import { Menu } from "../ui/menu";
import { debounce } from "../util";
import { type BasesViewConfig, groupByOf, limitOf, viewData } from "./config";
import type { QueryController } from "./controller";
import { exportRows } from "./export";
import { openFilterEditor, openFormulaEditor, openViewOptions } from "./options";
import type { BasesPropertyId } from "./property";
import { getBasesViewType, listBasesViewTypes } from "./view";

const LIMITS = [10, 25, 50, 100, 250, 500, 1000];

function below(el: HTMLElement) {
	const r = el.getBoundingClientRect();
	return { x: r.left, y: r.bottom + 4 };
}

export class BasesToolbar {
	#controller: QueryController;
	#viewButton: HTMLElement;
	#viewIcon: HTMLElement;
	#viewLabel: HTMLElement;
	#results: HTMLElement;
	#sort: HTMLElement;
	#group: HTMLElement;
	#filter: HTMLElement;
	#searchEl: HTMLInputElement;

	constructor(controller: QueryController, headerEl: HTMLElement) {
		this.#controller = controller;
		const bar = headerEl.createDiv("bases-toolbar");
		this.#viewButton = this.#item(bar, "bases-toolbar-views-menu", null, "", (el) => this.#viewsMenu(el));
		this.#viewIcon = this.#viewButton.createSpan("bases-toolbar-icon");
		this.#viewLabel = this.#viewButton.createSpan("bases-toolbar-label");
		setIcon(this.#viewButton.createSpan("bases-toolbar-chevron"), "chevron-down");
		this.#results = this.#item(bar, "bases-toolbar-results-menu", null, "", (el) => this.#resultsMenu(el));
		bar.createDiv("bases-toolbar-spacer");
		this.#searchEl = bar.createEl("input", { type: "search", cls: "bases-toolbar-search-input", placeholder: "Search" });
		this.#searchEl.hide();
		const search = debounce(() => {
			this.#controller.search = this.#searchEl.value;
			this.#controller.run();
		}, 150, true);
		this.#searchEl.addEventListener("input", () => search());
		this.#searchEl.addEventListener("keydown", (evt) => {
			if (evt.key !== "Escape") return;
			evt.stopPropagation();
			this.#searchEl.value = "";
			search();
			search.run();
			this.#searchEl.hide();
		});
		this.#item(bar, "bases-toolbar-search", "search", "Search", () => {
			this.#searchEl.show();
			this.#searchEl.focus();
		});
		this.#sort = this.#item(bar, "bases-toolbar-sort-menu", "arrow-up-down", "Sort", (el) => this.#sortMenu(el));
		this.#group = this.#item(bar, "bases-toolbar-group-menu", "layers", "Group", (el) => this.#groupMenu(el));
		this.#filter = this.#item(bar, "bases-toolbar-filter-menu", "filter", "Filter", () => openFilterEditor(this.#controller));
		this.#item(bar, "bases-toolbar-properties-menu", "list", "Properties", (el) => this.#propertiesMenu(el));
		const add = this.#item(bar, "bases-toolbar-new-item-menu", "plus", "New", () => this.#newNote());
		add.createSpan({ cls: "bases-toolbar-label", text: "New" });
	}

	#item(bar: HTMLElement, cls: string, icon: string | null, title: string, onClick: (el: HTMLElement) => void) {
		const el = bar.createDiv(`bases-toolbar-item ${cls}`);
		if (icon) {
			el.addClass("clickable-icon");
			setIcon(el.createSpan("bases-toolbar-icon"), icon);
		}
		if (title) setTooltip(el, title);
		el.addEventListener("click", (evt) => {
			evt.stopPropagation();
			onClick(el);
		});
		return el;
	}

	get #config(): BasesViewConfig | undefined {
		return this.#controller.configs[this.#controller.viewIndex];
	}

	update() {
		const c = this.#controller;
		const config = this.#config;
		const type = config ? viewData(config).type : "table";
		setIcon(this.#viewIcon, getBasesViewType(type)?.icon ?? "table");
		this.#viewLabel.setText(c.document?.error ? "Invalid base" : c.viewName);
		const count = c.currentResult.data.length;
		this.#results.setText(`${count} result${count === 1 ? "" : "s"}`);
		this.#sort.toggleClass("is-active", !!config && config.getSort().length > 0);
		this.#group.toggleClass("is-active", !!config && groupByOf(config) !== null);
		const filters = config ? viewData(config).filters : undefined;
		this.#filter.toggleClass("is-active", !!c.document?.config.filters || !!filters);
	}

	#name(id: BasesPropertyId) {
		return this.#config?.getDisplayName(id) ?? id;
	}

	#viewsMenu(el: HTMLElement) {
		const c = this.#controller;
		const menu = new Menu();
		// A base with an error can only be opened as text.
		if (!c.document.error) this.#viewItems(menu);
		c.source.addMenuItems?.(menu);
		if (menu.items.length) menu.showAtPosition(below(el));
	}

	#viewItems(menu: Menu) {
		const c = this.#controller;
		c.configs.forEach((config, i) => {
			menu.addItem((item) =>
				item
					.setTitle(config.name || "Untitled view")
					.setIcon(getBasesViewType(viewData(config).type)?.icon ?? "help-circle")
					.setChecked(i === c.viewIndex)
					.setSection("views")
					.onClick(() => c.selectView(i)),
			);
		});
		menu.addItem((item) => {
			item.setTitle("Add view").setIcon("plus").setSection("edit");
			const sub = item.setSubmenu();
			for (const [id, reg] of listBasesViewTypes()) sub.addItem((i) => i.setTitle(reg.name).setIcon(reg.icon).onClick(() => c.addView(id)));
		});
		menu.addItem((item) => item.setTitle("View settings").setIcon("settings").setSection("edit").onClick(() => openViewOptions(c)));
		if (c.configs.length > 1) {
			menu.addItem((item) =>
				item
					.setTitle("Delete view")
					.setIcon("trash-2")
					.setWarning(true)
					.setSection("danger")
					.onClick(() => c.removeView(c.viewIndex)),
			);
		}
	}

	#resultsMenu(el: HTMLElement) {
		const config = this.#config;
		if (!config) return;
		const menu = new Menu();
		menu.addItem((item) => {
			const limit = limitOf(config);
			item.setTitle(limit ? `Limit: ${limit}` : "Limit results").setIcon("list-ordered").setSection("limit");
			const sub = item.setSubmenu();
			sub.addItem((i) => i.setTitle("No limit").setChecked(limit === null).onClick(() => this.#set(config, "limit", null)));
			for (const n of LIMITS) sub.addItem((i) => i.setTitle(String(n)).setChecked(limit === n).onClick(() => this.#set(config, "limit", n)));
		});
		menu.addItem((item) => item.setTitle("Copy to clipboard").setIcon("copy").setSection("export").onClick(() => exportRows(this.#controller, "clipboard")));
		menu.addItem((item) => item.setTitle("Export CSV").setIcon("download").setSection("export").onClick(() => exportRows(this.#controller, "csv")));
		menu.showAtPosition(below(el));
	}

	#set(config: BasesViewConfig, key: string, value: unknown) {
		config.set(key, value);
		this.#controller.run();
	}

	#sortMenu(el: HTMLElement) {
		const config = this.#config;
		if (!config) return;
		const sorts = config.getSort();
		const menu = new Menu();
		sorts.forEach((sort, i) => {
			menu.addItem((item) => {
				item.setTitle(`${this.#name(sort.property)} ${sort.direction === "ASC" ? "↑" : "↓"}`).setSection("sorts");
				const sub = item.setSubmenu();
				const write = (next: typeof sorts) => this.#set(config, "sort", next.length ? next : null);
				const flip = (direction: "ASC" | "DESC") => sorts.map((s, j) => (j === i ? { ...s, direction } : s));
				sub.addItem((x) => x.setTitle("Ascending").setChecked(sort.direction === "ASC").onClick(() => write(flip("ASC"))));
				sub.addItem((x) => x.setTitle("Descending").setChecked(sort.direction === "DESC").onClick(() => write(flip("DESC"))));
				sub.addItem((x) => x.setTitle("Remove sort").setIcon("trash-2").onClick(() => write(sorts.filter((_s, j) => j !== i))));
			});
		});
		menu.addItem((item) => {
			item.setTitle("Add sort").setIcon("plus").setSection("add");
			const sub = item.setSubmenu();
			for (const id of this.#controller.allProperties) {
				if (sorts.some((s) => s.property === id)) continue;
				sub.addItem((x) => x.setTitle(this.#name(id)).onClick(() => this.#set(config, "sort", [...sorts, { property: id, direction: "ASC" }])));
			}
		});
		if (sorts.length) menu.addItem((item) => item.setTitle("Clear sort").setIcon("x").setSection("add").onClick(() => this.#set(config, "sort", null)));
		menu.showAtPosition(below(el));
	}

	#groupMenu(el: HTMLElement) {
		const config = this.#config;
		if (!config) return;
		const groupBy = groupByOf(config);
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle(groupBy ? `Group by ${this.#name(groupBy.property)}` : "Group by").setIcon("layers").setSection("group");
			const sub = item.setSubmenu();
			sub.addItem((x) => x.setTitle("No grouping").setChecked(!groupBy).onClick(() => this.#set(config, "groupBy", null)));
			for (const id of this.#controller.allProperties) {
				sub.addItem((x) =>
					x
						.setTitle(this.#name(id))
						.setChecked(groupBy?.property === id)
						.onClick(() => this.#set(config, "groupBy", { property: id, direction: groupBy?.direction ?? "ASC" })),
				);
			}
		});
		if (groupBy) {
			for (const direction of ["ASC", "DESC"] as const) {
				menu.addItem((item) =>
					item
						.setTitle(direction === "ASC" ? "Ascending" : "Descending")
						.setChecked(groupBy.direction === direction)
						.setSection("direction")
						.onClick(() => this.#set(config, "groupBy", { property: groupBy.property, direction })),
				);
			}
		}
		menu.showAtPosition(below(el));
	}

	#propertiesMenu(el: HTMLElement) {
		const config = this.#config;
		if (!config) return;
		const order = config.getOrder();
		const menu = new Menu();
		for (const id of this.#controller.allProperties) {
			const shown = order.includes(id);
			menu.addItem((item) =>
				item
					.setTitle(this.#name(id))
					.setChecked(shown)
					.setSection(id.split(".")[0])
					.onClick(() => this.#set(config, "order", shown ? order.filter((p) => p !== id) : [...order, id])),
			);
		}
		menu.addItem((item) => item.setTitle("Add formula").setIcon("plus").setSection("add").onClick(() => openFormulaEditor(this.#controller)));
		menu.showAtPosition(below(el));
	}

	#newNote() {
		if (this.#controller.document.error) return;
		const view = this.#controller.view;
		(view ? view.createFileForView() : this.#controller.createFileForView()).catch((err) => console.error("Could not create a note for the base", err));
	}
}
