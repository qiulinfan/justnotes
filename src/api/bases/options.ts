// The dialogs behind the toolbar: view settings (with the options a view type
// declares), the filter editor and the formula editor.
import { Modal } from "../ui/modal";
import { type AbstractTextComponent, Setting } from "../ui/setting";
import { parseYaml, stringifyYaml } from "../util";
import { type BasesViewConfig, groupByOf, limitOf, sameConfig, viewData } from "./config";
import type { QueryController } from "./controller";
import { parseExpression } from "./expression";
import { type BasesPropertyId, normalizePropertyId, parsePropertyId } from "./property";
import { ErrorValue } from "./values";
import { type BasesAllOptions, type BasesOptions, getBasesViewType, listBasesViewTypes } from "./view";

// Text settings apply when the field is left or Enter is pressed, so typing
// does not rewrite the .base file on every key.
function onCommit(text: AbstractTextComponent<HTMLInputElement | HTMLTextAreaElement>, cb: (value: string) => void) {
	text.inputEl.addEventListener("change", () => cb(text.getValue()));
}

class ViewOptionsModal extends Modal {
	#controller: QueryController;
	#config: BasesViewConfig;
	#hidden: [() => boolean, HTMLElement][] = [];

	constructor(controller: QueryController) {
		super(controller.app);
		this.#controller = controller;
		this.#config = controller.configs[controller.viewIndex];
		this.modalEl.addClass("bases-view-options");
		this.setTitle("View settings");
	}

	onOpen() {
		this.#render();
	}

	#render() {
		const { contentEl } = this;
		const config = this.#config;
		const c = this.#controller;
		contentEl.empty();
		this.#hidden = [];
		new Setting(contentEl).setName("Name").addText((t) => {
			t.setValue(config.name);
			onCommit(t, (v) => v.trim() && config.set("name", v.trim()));
		});
		new Setting(contentEl).setName("Layout").addDropdown((d) => {
			for (const [id, reg] of listBasesViewTypes()) d.addOption(id, reg.name);
			d.setValue(viewData(config).type);
			d.onChange((type) => {
				config.set("type", type);
				this.#render();
			});
		});
		const groupBy = groupByOf(config);
		new Setting(contentEl)
			.setName("Group by")
			.addDropdown((d) => {
				d.addOption("", "None");
				for (const id of c.allProperties) d.addOption(id, config.getDisplayName(id));
				d.setValue(groupBy?.property ?? "");
				d.onChange((property) => {
					config.set("groupBy", property ? { property, direction: groupBy?.direction ?? "ASC" } : null);
					this.#render();
				});
			})
			.addDropdown((d) => {
				d.addOptions({ ASC: "Ascending", DESC: "Descending" }).setValue(groupBy?.direction ?? "ASC");
				d.setDisabled(!groupBy);
				d.onChange((direction) => groupBy && config.set("groupBy", { property: groupBy.property, direction }));
			});
		new Setting(contentEl).setName("Limit").setDesc("Show at most this many results; empty shows all.").addText((t) => {
			t.inputEl.type = "number";
			t.setValue(String(limitOf(config) ?? ""));
			onCommit(t, (v) => config.set("limit", Number(v) > 0 ? Math.floor(Number(v)) : null));
		});
		const registration = getBasesViewType(viewData(config).type);
		let options: BasesAllOptions[] = [];
		try {
			options = registration?.options?.(config) ?? [];
		} catch (err) {
			console.error("Bases view options failed", err);
		}
		for (const option of options) {
			if (option.type === "group") {
				const heading = new Setting(contentEl).setName(option.displayName).setHeading();
				const group = contentEl.createDiv("bases-option-group");
				if (option.shouldHide) this.#hidden.push([option.shouldHide, heading.settingEl], [option.shouldHide, group]);
				for (const item of option.items) this.#option(group, item);
			} else this.#option(contentEl, option);
		}
		this.#refresh();
	}

	#refresh() {
		for (const [shouldHide, el] of this.#hidden) {
			let hide = false;
			try {
				hide = shouldHide();
			} catch {}
			el.toggle(!hide);
		}
	}

	#set(key: string, value: unknown) {
		this.#config.set(key, value);
		this.#refresh();
	}

	#option(el: HTMLElement, option: BasesOptions) {
		const config = this.#config;
		const setting = new Setting(el).setName(option.displayName);
		if (option.shouldHide) this.#hidden.push([option.shouldHide, setting.settingEl]);
		const current = config.get(option.key) ?? option.default;
		switch (option.type) {
			case "dropdown":
				setting.addDropdown((d) => d.addOptions(option.options ?? {}).setValue(String(current ?? "")).onChange((v) => this.#set(option.key, v)));
				break;
			case "toggle":
				setting.addToggle((t) => t.setValue(!!current).onChange((v) => this.#set(option.key, v)));
				break;
			case "slider":
				setting.addSlider((s) =>
					s
						.setLimits(option.min ?? 0, option.max ?? 100, option.step ?? 1)
						.setValue(Number(current ?? option.min ?? 0))
						.setInstant(!!option.instant)
						.setDynamicTooltip()
						.onChange((v) => this.#set(option.key, v)),
				);
				break;
			case "multitext":
				setting.addTextArea((t) => {
					t.setValue((Array.isArray(current) ? current : []).join("\n"));
					t.setPlaceholder("One value per line");
					onCommit(t, (v) => this.#set(option.key, v.split("\n").map((s) => s.trim()).filter(Boolean)));
				});
				break;
			case "property":
				setting.addDropdown((d) => {
					d.addOption("", option.placeholder ?? "None");
					for (const id of this.#controller.allProperties) {
						if (!option.filter || option.filter(id)) d.addOption(id, config.getDisplayName(id));
					}
					d.setValue(String(current ?? ""));
					d.onChange((v) => this.#set(option.key, v || null));
				});
				break;
			case "file":
			case "folder":
			case "formula":
			case "text":
				setting.addText((t) => {
					t.setValue(String(current ?? "")).setPlaceholder(option.placeholder ?? "");
					if (option.type === "file" || option.type === "folder") this.#suggestPaths(t.inputEl, option);
					onCommit(t, (v) => this.#set(option.key, v || null));
				});
				break;
		}
	}

	// File and folder options offer the vault's paths as the user types.
	#suggestPaths(input: HTMLInputElement, option: BasesOptions & { type: "file" | "folder" }) {
		const { vault } = this.app;
		const paths =
			option.type === "file"
				? vault.getFiles().filter((f) => !option.filter || option.filter(f)).map((f) => f.path)
				: vault.getAllFolders(true).filter((f) => !option.filter || option.filter(f)).map((f) => f.path);
		const list = this.contentEl.createEl("datalist", { attr: { id: `bases-paths-${option.key}` } });
		for (const path of paths.slice(0, 2000)) list.createEl("option", { value: path });
		input.setAttr("list", list.id);
	}
}

export function openViewOptions(controller: QueryController) {
	if (controller.configs[controller.viewIndex]) new ViewOptionsModal(controller).open();
}

// Filters edited as YAML: a formula string or and/or/not lists, for all views
// and for this view.
class FilterModal extends Modal {
	constructor(controller: QueryController) {
		super(controller.app);
		this.modalEl.addClass("bases-filter-editor");
		this.setTitle("Filters");
		const config = controller.configs[controller.viewIndex];
		const yaml = (value: unknown) => (value === undefined || value === null ? "" : stringifyYaml(value).trimEnd());
		const fields = [
			{ name: "All views", value: yaml(controller.document.config.filters) },
			{ name: "This view", value: yaml(viewData(config).filters) },
		].map(({ name, value }) => {
			new Setting(this.contentEl).setName(name).setHeading();
			const input = this.contentEl.createEl("textarea", { cls: "bases-filter-input", attr: { rows: 6, spellcheck: "false" } });
			input.value = value;
			input.placeholder = 'and:\n  - file.inFolder("Projects")\n  - status != "done"';
			return { name, input };
		});
		const errorEl = this.contentEl.createDiv("bases-message-item mod-warning");
		errorEl.hide();
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					const parsed: unknown[] = [];
					for (const { name, input } of fields) {
						try {
							const value = input.value.trim() ? parseYaml(input.value) : undefined;
							const problem = firstFormulaError(value);
							if (problem) throw new Error(problem);
							parsed.push(value);
						} catch (err) {
							errorEl.setText(`${name}: ${(err as Error).message}`);
							errorEl.show();
							return;
						}
					}
					// Only what changed is written, so the other filters keep their comments.
					if (!sameConfig(parsed[0], controller.document.config.filters)) controller.setBaseKey(["filters"], parsed[0]);
					config.set("filters", parsed[1] ?? null);
					controller.run();
					this.close();
				}),
		);
	}
}

function firstFormulaError(filter: unknown): string | null {
	if (typeof filter === "string") return parseExpression(filter).error;
	if (Array.isArray(filter)) {
		for (const f of filter) {
			const problem = firstFormulaError(f);
			if (problem) return problem;
		}
	} else if (filter && typeof filter === "object") return firstFormulaError(Object.values(filter));
	return null;
}

export function openFilterEditor(controller: QueryController) {
	if (!controller.document.error && controller.configs[controller.viewIndex]) new FilterModal(controller).open();
}

// Name and formula for a new formula property, previewed on the first result.
class FormulaModal extends Modal {
	constructor(controller: QueryController) {
		super(controller.app);
		this.modalEl.addClass("bases-formula-editor");
		this.setTitle("Add formula");
		let name = "";
		let formula = "";
		const preview = createDiv("bases-formula-preview");
		const update = () => {
			preview.empty();
			if (!formula.trim()) return;
			const parsed = parseExpression(formula);
			const entry = controller.currentResult.data[0];
			if (!parsed.node || !entry) {
				if (parsed.error) preview.createSpan({ cls: "bases-error-value", text: parsed.error });
				return;
			}
			preview.createSpan({ cls: "bases-formula-preview-label", text: `${entry.file.basename}: ` });
			const value = controller.evaluateFor(entry, formula);
			if (value instanceof ErrorValue) preview.createSpan({ cls: "bases-error-value", text: value.message });
			else value.renderTo(preview.createSpan());
		};
		new Setting(this.contentEl).setName("Name").addText((t) => t.setPlaceholder("total").onChange((v) => (name = v.trim())));
		new Setting(this.contentEl).setName("Formula").addTextArea((t) => {
			t.setPlaceholder("price * quantity");
			t.inputEl.rows = 3;
			t.onChange((v) => {
				formula = v;
				update();
			});
		});
		this.contentEl.appendChild(preview);
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText("Add")
				.setCta()
				.onClick(() => {
					if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) {
						preview.empty();
						preview.createSpan({ cls: "bases-error-value", text: "A formula name is letters, digits and _, and starts with a letter." });
						return;
					}
					if (!formula.trim() || parseExpression(formula).error) return;
					controller.setBaseKey(["formulas", name], formula);
					const config = controller.configs[controller.viewIndex];
					const id: BasesPropertyId = `formula.${name}`;
					if (config && !config.getOrder().includes(id)) config.set("order", [...config.getOrder(), id]);
					controller.run();
					this.close();
				}),
		);
	}
}

export function openFormulaEditor(controller: QueryController) {
	if (!controller.document.error) new FormulaModal(controller).open();
}

// The display name of a property, kept in the base's `properties`.
class RenameModal extends Modal {
	#input: HTMLInputElement;

	constructor(controller: QueryController, id: BasesPropertyId) {
		super(controller.app);
		this.setTitle("Property display name");
		const config = controller.configs[controller.viewIndex];
		this.#input = this.contentEl.createEl("input", { type: "text", cls: "prompt-modal-input", value: config.getDisplayName(id) });
		this.#input.addEventListener("keydown", (evt) => {
			if (evt.key !== "Enter" || evt.isComposing) return;
			evt.preventDefault();
			// Reuse the key the base already has for this property; a new note
			// property is written by its bare name, as Obsidian does.
			const { type, name } = parsePropertyId(id);
			const keys = Object.keys(controller.document.config.properties ?? {});
			const key = keys.find((k) => normalizePropertyId(k) === id) ?? (type === "note" ? name : id);
			controller.setBaseKey(["properties", key, "displayName"], this.#input.value.trim() || undefined);
			this.close();
		});
	}

	onOpen() {
		this.#input.focus();
		this.#input.select();
	}
}

export function openRenameProperty(controller: QueryController, id: BasesPropertyId) {
	if (!controller.document.error && controller.configs[controller.viewIndex]) new RenameModal(controller, id).open();
}
