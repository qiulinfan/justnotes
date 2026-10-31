// The built-in list view: one item per entry, with the file name and the
// view's other properties on one line.
import { BatchRenderer } from "./batches";
import { isEmptyValue } from "./compare";
import type { QueryController } from "./controller";
import type { BasesEntry } from "./entry";
import type { BasesPropertyId } from "./property";
import { renderFileLink } from "./table-view";
import { renderContextOf } from "./values";
import { BasesView, type BasesViewRegistration } from "./view";

export class ListView extends BasesView {
	type = "list";
	#el: HTMLElement;
	#batches = new BatchRenderer();

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.#el = containerEl.createDiv("bases-list-container");
	}

	onunload() {
		this.#batches.stop();
		this.#el.detach();
	}

	onDataUpdated() {
		const scrollTop = this.#el.scrollTop;
		this.#el.empty();
		const markers = String(this.config.get("markers") ?? "bullet");
		const separator = String(this.config.get("separator") ?? " · ");
		// An item always shows its file: first, unless the order places file.name.
		const order = this.config.getOrder();
		const properties: BasesPropertyId[] = order.includes("file.name") ? order : ["file.name", ...order];
		const groups = this.data.groupedData;
		const grouped = groups.some((g) => g.key !== undefined);
		const tasks: (() => void)[] = [];
		for (const group of groups) {
			let list: HTMLElement | null = null;
			const section = () => {
				if (list) return list;
				const el = this.#el.createDiv("bases-list-group");
				if (grouped) {
					const heading = el.createDiv("bases-list-group-heading");
					if (group.hasKey()) group.key!.renderTo(heading, renderContextOf(this.app));
					else heading.setText("No value");
					heading.createSpan({ cls: "bases-group-count", text: String(group.entries.length) });
				}
				list = el.createEl(markers === "number" ? "ol" : "ul", markers === "none" ? "bases-list-group-list mod-none" : "bases-list-group-list");
				return list;
			};
			for (const entry of group.entries) tasks.push(() => this.#item(section(), entry, properties, separator));
		}
		if (!this.data.data.length) this.#el.createDiv({ cls: "bases-view-missing", text: "No results" });
		this.#batches.render(this.#el, tasks, scrollTop);
	}

	#item(list: HTMLElement, entry: BasesEntry, properties: BasesPropertyId[], separator: string) {
		const li = list.createEl("li", "bases-list-entry");
		let first = true;
		for (const id of properties) {
			const value = id === "file.name" ? null : entry.getValue(id);
			if (id !== "file.name" && (!value || isEmptyValue(value))) continue;
			if (!first) li.createSpan({ cls: "bases-list-separator", text: separator });
			first = false;
			if (id === "file.name") renderFileLink(this, li.createSpan("bases-list-entry-property"), entry);
			else value!.renderTo(li.createSpan("bases-list-entry-property"), renderContextOf(this.app));
		}
	}
}

export const LIST_VIEW: BasesViewRegistration = {
	name: "List",
	icon: "list",
	factory: (controller, containerEl) => new ListView(controller, containerEl),
	options: () => [
		{ type: "dropdown", key: "markers", displayName: "Markers", default: "bullet", options: { bullet: "Bullets", number: "Numbers", none: "None" } },
		{ type: "text", key: "separator", displayName: "Property separator", default: " · ", placeholder: " · " },
	],
};
