// The built-in cards view: a grid of cards with an optional cover image, the
// file name and the view's other properties.
import { Keymap } from "../keymap";
import { getLinkpath } from "../metadata-utils";
import { BatchRenderer } from "./batches";
import { isEmptyValue } from "./compare";
import type { QueryController } from "./controller";
import type { BasesEntry } from "./entry";
import type { BasesPropertyId } from "./property";
import { renderFileLink } from "./table-view";
import { FileValue, ImageValue, LinkValue, ListValue, renderContextOf, StringValue, type Value } from "./values";
import { BasesView, type BasesViewRegistration } from "./view";

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export class CardsView extends BasesView {
	type = "cards";
	#el: HTMLElement;
	#batches = new BatchRenderer();

	constructor(controller: QueryController, containerEl: HTMLElement) {
		super(controller);
		this.#el = containerEl.createDiv("bases-cards-container");
	}

	onunload() {
		this.#batches.stop();
		this.#el.detach();
	}

	onDataUpdated() {
		const scrollTop = this.#el.scrollTop;
		this.#el.empty();
		const size = Number(this.config.get("cardSize")) || 200;
		// The ratio is the cover's height to its width; 1.35 suits book covers.
		const ratio = Number(this.config.get("imageAspectRatio")) || 1;
		this.#el.style.setProperty("--bases-card-width", `${size}px`);
		this.#el.style.setProperty("--bases-card-aspect", String(1 / ratio));
		const image = this.config.getAsPropertyId("image");
		const contain = this.config.get("imageFit") === "contain";
		const properties = this.config.getOrder().filter((id) => id !== "file.name" && id !== image);
		const groups = this.data.groupedData;
		const grouped = groups.some((g) => g.key !== undefined);
		const tasks: (() => void)[] = [];
		for (const group of groups) {
			let grid: HTMLElement | null = null;
			const section = () => {
				if (grid) return grid;
				const el = this.#el.createDiv("bases-cards-group");
				if (grouped) {
					const heading = el.createDiv("bases-cards-group-heading");
					if (group.hasKey()) group.key!.renderTo(heading, renderContextOf(this.app));
					else heading.setText("No value");
					heading.createSpan({ cls: "bases-group-count", text: String(group.entries.length) });
				}
				grid = el.createDiv("bases-cards-grid");
				return grid;
			};
			for (const entry of group.entries) tasks.push(() => this.#card(section(), entry, image, contain, properties));
		}
		if (!this.data.data.length) this.#el.createDiv({ cls: "bases-view-missing", text: "No results" });
		this.#batches.render(this.#el, tasks, scrollTop);
	}

	#card(grid: HTMLElement, entry: BasesEntry, image: BasesPropertyId | null, contain: boolean, properties: BasesPropertyId[]) {
		const card = grid.createDiv("bases-cards-item");
		card.addEventListener("click", (evt) => {
			if ((evt.target as HTMLElement).closest("a, input")) return;
			this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(entry.file);
		});
		if (image) {
			const cover = card.createDiv(contain ? "bases-cards-cover mod-contain" : "bases-cards-cover");
			const source = this.#cover(entry.getValue(image));
			if (source && HEX_COLOR.test(source)) cover.style.backgroundColor = source;
			else if (source) cover.style.backgroundImage = `url("${source.replace(/["\\]/g, "\\$&")}")`;
		}
		const content = card.createDiv("bases-cards-content");
		renderFileLink(this, content.createDiv("bases-cards-title"), entry);
		for (const id of properties) {
			const value = entry.getValue(id);
			if (!value || isEmptyValue(value)) continue;
			const row = content.createDiv("bases-cards-property");
			row.createSpan({ cls: "bases-cards-label", text: this.config.getDisplayName(id) });
			value.renderTo(row.createSpan(), renderContextOf(this.app));
		}
	}

	// A cover is an image value, a link to an attachment, a URL, a vault path,
	// or a hex colour.
	#cover(value: Value | null): string | null {
		if (!value) return null;
		if (value instanceof ListValue) return this.#cover(value.items[0] ?? null);
		if (value instanceof ImageValue) return value.src();
		const { vault, metadataCache } = this.app;
		if (value instanceof FileValue) return vault.getResourcePath(value.file);
		if (value instanceof LinkValue) {
			const file = value.resolve();
			return file ? vault.getResourcePath(file) : null;
		}
		if (!(value instanceof StringValue)) return null;
		const text = value.value.trim();
		if (HEX_COLOR.test(text) || /^(https?|data|app|file):/i.test(text)) return text;
		const file = text ? metadataCache.getFirstLinkpathDest(getLinkpath(text), "") : null;
		return file ? vault.getResourcePath(file) : null;
	}
}

export const CARDS_VIEW: BasesViewRegistration = {
	name: "Cards",
	icon: "layout-grid",
	factory: (controller, containerEl) => new CardsView(controller, containerEl),
	options: (config) => [
		{ type: "slider", key: "cardSize", displayName: "Card size", min: 100, max: 600, step: 10, default: 200 },
		{ type: "property", key: "image", displayName: "Image property", placeholder: "None" },
		{ type: "dropdown", key: "imageFit", displayName: "Image fit", default: "", options: { "": "Cover", contain: "Contain" }, shouldHide: () => !config.get("image") },
		{ type: "slider", key: "imageAspectRatio", displayName: "Image aspect ratio", min: 0.25, max: 2.5, step: 0.05, default: 1, shouldHide: () => !config.get("image") },
	],
};
