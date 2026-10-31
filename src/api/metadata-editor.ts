// The Properties block at the top of a note (Obsidian's metadata editor), in
// Live Preview and in the reading view. Every edit rewrites the note's
// frontmatter text through the host, which puts it in the editor document:
// it saves like typing, undoes with Mod+Z, and merges with outside changes.
// The YAML is edited one property at a time (frontmatter-edit.ts), so the
// others keep their bytes.
import { redo, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { App } from "./app";
import { Component } from "./events";
import { insertProperty, locateFrontmatter, readProperties, removeProperty, renameProperty, replaceFrontmatter, setProperty } from "./frontmatter-edit";
import { setIcon, setTooltip } from "./icons";
import { Keymap } from "./keymap";
import { convertValue, type PropertyRenderContext, type PropertyWidget, type PropertyWidgetComponent } from "./metadata-types";
import { Menu } from "./ui/menu";
import { Notice } from "./ui/notice";
import { AbstractInputSuggest } from "./ui/suggest";
import { textChanges } from "./view";

export interface MetadataEditorHost {
	app: App;
	sourcePath(): string;
	// The frontmatter YAML now: "" for an empty block, null without one.
	getYaml(): string | null;
	// Replaces the YAML; "" removes the block.
	setYaml(yaml: string): void;
	// Moves focus into the note below the properties.
	focusBody(): void;
	// Shows the frontmatter as YAML, for properties that do not parse.
	showSource?(): void;
	undo?(): void;
	redo?(): void;
	collapsed?: boolean;
}

// A host over a note's CodeMirror editor: edits are transactions there, so
// they save, undo and reach the note's other panes like typing.
export function editorMetadataHost(cm: EditorView, app: App, sourcePath: () => string): MetadataEditorHost {
	const frontmatter = () => {
		const text = cm.state.doc.toString();
		return { text, fm: locateFrontmatter(text) };
	};
	return {
		app,
		sourcePath,
		getYaml() {
			const { text, fm } = frontmatter();
			return fm ? text.slice(fm.yamlFrom, fm.yamlTo) : null;
		},
		setYaml(yaml) {
			const text = cm.state.doc.toString();
			const changes = textChanges(text, replaceFrontmatter(text, yaml));
			if (changes.length) cm.dispatch({ changes, userEvent: "input.properties" });
		},
		// The caret goes to the start of the note's first line after the block.
		// A note that ends with its block gets a line for it.
		focusBody() {
			const { text, fm } = frontmatter();
			const pos = fm?.to ?? 0;
			if (fm && !text.slice(fm.yamlTo, pos).endsWith("\n")) cm.dispatch({ changes: { from: pos, insert: "\n" }, selection: { anchor: pos + 1 }, userEvent: "select" });
			else cm.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: "select" });
			cm.focus();
		},
		showSource() {
			cm.dispatch({ selection: { anchor: frontmatter().fm?.yamlFrom ?? 0 }, scrollIntoView: true });
			cm.focus();
		},
		undo: () => undo(cm),
		redo: () => redo(cm),
	};
}

const editors = new WeakMap<HTMLElement, MetadataEditor>();

// The editor whose container is `el`.
export function metadataEditorOf(el: Element | null | undefined) {
	return el ? editors.get(el as HTMLElement) : undefined;
}

function same(a: unknown, b: unknown) {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

class KeySuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		el: HTMLInputElement,
		readonly taken: () => string[],
	) {
		super(app, el);
	}

	// What was typed comes first, so Enter keeps it unless a name is picked.
	getSuggestions(query: string) {
		const typed = query.trim();
		const q = typed.toLowerCase();
		const taken = new Set(this.taken().map((k) => k.toLowerCase()));
		const names = Object.values(this.app.metadataTypeManager.getAllProperties())
			.filter((p) => !taken.has(p.name.toLowerCase()) && p.name.toLowerCase().includes(q))
			.sort((a, b) => b.count - a.count)
			.map((p) => p.name);
		return typed && !names.includes(typed) ? [typed, ...names] : names;
	}

	renderSuggestion(value: string, el: HTMLElement) {
		el.setText(value);
	}
}

class PropertyRow {
	el: HTMLElement;
	keyInput: HTMLInputElement;
	iconEl: HTMLElement;
	valueEl: HTMLElement;
	// The widget type the value is shown with.
	type = "";
	widget: PropertyWidgetComponent | null = null;
	// A value that arrived while the value had focus, shown once it loses it.
	#stale = false;

	constructor(
		readonly editor: MetadataEditor,
		public key: string,
		public value: unknown,
		public pending = false,
	) {
		this.el = createDiv({ cls: "metadata-property", attr: { tabindex: 0, "data-property-key": key } });
		const keyEl = this.el.createDiv("metadata-property-key");
		this.iconEl = keyEl.createSpan({ cls: "metadata-property-icon", attr: { "aria-disabled": "false" } });
		this.keyInput = keyEl.createEl("input", {
			cls: "metadata-property-key-input",
			attr: { type: "text", autocapitalize: "none", enterkeyhint: "next", placeholder: "Name" },
		});
		this.keyInput.value = key;
		this.valueEl = this.el.createDiv("metadata-property-value");
		this.el.addEventListener("focusout", (evt) => {
			if (this.#stale && !this.valueEl.contains(evt.relatedTarget as Node | null)) this.render();
		});
	}

	focusKey() {
		this.keyInput.focus();
		this.keyInput.select();
	}

	focusValue(at?: "start" | "end") {
		if (this.pending) return this.focusKey();
		if (this.widget?.focus) this.widget.focus(at);
		else this.el.focus();
	}

	// A new value from the note; a value being edited keeps its widget.
	update(value: unknown) {
		this.el.setAttr("data-property-key", this.key);
		const changed = !same(value, this.value);
		this.value = value;
		if (!changed && this.#widgetFor().type === this.type) return;
		if (this.valueEl.contains(document.activeElement)) this.#stale = true;
		else this.render();
	}

	// The assigned type's widget, else the one the value is already shown
	// with while the value fits it (so typing a date into a text property does
	// not swap its widget), else the expected one. A value that does not fit
	// shows with the widget of its own type.
	#widgetFor(): PropertyWidget & { mismatch?: string } {
		const types = this.editor.app.metadataTypeManager;
		const info = types.getTypeInfo(this.key, this.value);
		const assigned = types.getAssignedType(this.key);
		const current = !assigned && this.type ? types.registeredTypeWidgets[this.type] : null;
		const expected = current?.validate(this.value) ? current : info.expected;
		if (expected.validate(this.value)) return expected;
		return { ...info.inferred, mismatch: expected.name() };
	}

	render() {
		this.#stale = false;
		this.el.setAttr("data-property-key", this.key);
		if (document.activeElement !== this.keyInput) this.keyInput.value = this.key;
		this.widget?.unload?.();
		this.widget = null;
		this.valueEl.empty();
		if (this.pending) {
			this.type = "";
			this.el.removeAttribute("data-property-type");
			setIcon(this.iconEl, "lucide-text");
			return;
		}
		const widget = this.#widgetFor();
		this.type = widget.type;
		this.el.setAttr("data-property-type", widget.type);
		this.el.toggleClass("has-type-mismatch", !!widget.mismatch);
		setIcon(this.iconEl, widget.icon);
		setTooltip(this.iconEl, widget.mismatch ? `Type mismatch, expected ${widget.mismatch}` : widget.name());
		const row = this;
		const ctx: PropertyRenderContext = {
			app: this.editor.app,
			get key() {
				return row.key;
			},
			sourcePath: this.editor.host.sourcePath(),
			onChange: (value) => this.editor.setValue(this, value),
			blur: () => this.el.focus(),
			metadataEditor: this.editor,
		};
		try {
			this.widget = widget.render(this.valueEl, this.value, ctx) || null;
		} catch (err) {
			console.error(`Property widget ${widget.type} failed`, err);
		}
	}

	destroy() {
		this.widget?.unload?.();
		this.el.detach();
	}
}

export class MetadataEditor extends Component {
	app: App;
	containerEl: HTMLElement;
	headingEl: HTMLElement;
	contentEl: HTMLElement;
	propertiesEl: HTMLElement;
	addPropertyButtonEl: HTMLElement;
	errorEl: HTMLElement;
	rows: PropertyRow[] = [];
	#selected = new Set<PropertyRow>();
	#anchor: PropertyRow | null = null;

	constructor(readonly host: MetadataEditorHost) {
		super();
		this.app = host.app;
		this.containerEl = createDiv("metadata-container");
		editors.set(this.containerEl, this);
		this.headingEl = this.containerEl.createDiv({ cls: "metadata-properties-heading", attr: { tabindex: 0 } });
		setIcon(this.headingEl.createDiv("collapse-indicator collapse-icon"), "right-triangle");
		this.headingEl.createDiv({ cls: "metadata-properties-title", text: "Properties" });
		this.contentEl = this.containerEl.createDiv("metadata-content");
		this.propertiesEl = this.contentEl.createDiv("metadata-properties");
		this.errorEl = this.contentEl.createDiv({ cls: "metadata-error", text: "Invalid properties. Click to edit the YAML." });
		this.errorEl.hide();
		this.addPropertyButtonEl = this.contentEl.createDiv({ cls: "metadata-add-button text-icon-button", attr: { tabindex: 0 } });
		setIcon(this.addPropertyButtonEl.createSpan("text-button-icon"), "plus");
		this.addPropertyButtonEl.createSpan({ cls: "text-button-label", text: "Add property" });
		this.#setCollapsed(!!host.collapsed);

		this.headingEl.addEventListener("click", () => this.#setCollapsed(!this.containerEl.hasClass("is-collapsed")));
		this.addPropertyButtonEl.addEventListener("click", () => this.addProperty());
		this.errorEl.addEventListener("click", () => host.showSource?.());
		this.containerEl.addEventListener("keydown", (evt) => this.#onKeydown(evt));
		this.containerEl.addEventListener("click", (evt) => this.#onPointer(evt));
		this.containerEl.addEventListener("contextmenu", (evt) => this.#onPointer(evt));
		this.containerEl.addEventListener("focusin", (evt) => {
			const row = this.#rowOf(evt.target);
			if (!row || !this.#selected.has(row)) this.#select([]);
		});
	}

	onload() {
		this.registerEvent(this.app.metadataTypeManager.on("changed", (name?: string) => this.#retype(name)));
	}

	onunload() {
		for (const row of this.rows) row.destroy();
		this.rows = [];
	}

	#setCollapsed(collapsed: boolean) {
		this.containerEl.toggleClass("is-collapsed", collapsed);
		this.host.collapsed = collapsed;
	}

	// Shows the properties of `yaml` (null: the note has none), keeping the
	// rows, and the focus, of properties that are still there.
	sync(yaml: string | null) {
		const entries = readProperties(yaml ?? "");
		this.containerEl.toggleClass("mod-error", !entries);
		this.errorEl.toggle(!entries);
		this.propertiesEl.toggle(!!entries);
		this.addPropertyButtonEl.toggle(!!entries);
		if (!entries) return;
		const old = new Map(this.rows.filter((r) => !r.pending).map((r) => [r.key, r]));
		const rows: PropertyRow[] = [];
		for (const [key, value] of entries) {
			let row = old.get(key);
			if (row) {
				old.delete(key);
				row.update(value);
			} else {
				row = new PropertyRow(this, key, value);
				row.render();
				this.#bindKey(row);
			}
			rows.push(row);
		}
		for (const row of old.values()) {
			this.#selected.delete(row);
			row.destroy();
		}
		this.rows = [...rows, ...this.rows.filter((r) => r.pending)];
		// Only rows out of place move: moving a node takes its focus away.
		let at: ChildNode | null = this.propertiesEl.firstChild;
		for (const row of this.rows) {
			if (row.el === at) at = at.nextSibling;
			else this.propertiesEl.insertBefore(row.el, at);
		}
		this.containerEl.setAttr("data-property-count", rows.length);
	}

	#retype(name?: string) {
		for (const row of this.rows) if (!row.pending && (!name || row.key.toLowerCase() === name.toLowerCase())) row.update(row.value);
	}

	#yaml() {
		return this.host.getYaml() ?? "";
	}

	#write(yaml: string) {
		const now = this.host.getYaml();
		if (yaml === (now ?? "") && now !== null) return;
		// No property left: the block goes.
		this.host.setYaml(readProperties(yaml)?.length === 0 ? "" : yaml);
	}

	setValue(row: PropertyRow, value: unknown) {
		if (row.pending || same(value, row.value)) return;
		row.value = value;
		this.#write(setProperty(this.#yaml(), row.key, value));
	}

	// A new row with its name to fill in; it reaches the note once named.
	addProperty() {
		this.#setCollapsed(false);
		const pending = this.rows.find((r) => r.pending);
		if (pending) return pending.focusKey();
		const row = new PropertyRow(this, "", null, true);
		row.render();
		this.#bindKey(row);
		this.rows.push(row);
		this.propertiesEl.appendChild(row.el);
		row.focusKey();
	}

	#bindKey(row: PropertyRow) {
		const input = row.keyInput;
		const suggest = new KeySuggest(this.app, input, () => this.rows.filter((r) => r !== row).map((r) => r.key));
		let picked = false;
		suggest.onSelect((name) => {
			picked = true;
			suggest.close();
			input.value = name;
			this.#commitKey(row, true);
		});
		input.addEventListener("keydown", (evt) => {
			if (evt.isComposing || evt.defaultPrevented) return;
			if (evt.key === "Enter") {
				evt.preventDefault();
				this.#commitKey(row, true);
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				evt.stopPropagation();
				input.value = row.key;
				if (row.pending) this.#dropPending(row);
				else row.el.focus();
			}
		});
		input.addEventListener("blur", () => {
			if (picked) picked = false;
			else if (row.el.isConnected) this.#commitKey(row, false);
		});
	}

	// The name typed into a row: a new property is added, an existing one
	// renamed. `next` moves on to the value.
	#commitKey(row: PropertyRow, next: boolean) {
		const name = row.keyInput.value.trim();
		const taken = this.rows.some((r) => r !== row && !r.pending && r.key === name);
		if (row.pending) {
			if (!name) return this.#dropPending(row);
			if (taken) {
				new Notice(`A property named "${name}" already exists`);
				return this.#dropPending(row, name);
			}
			row.key = name;
			row.pending = false;
			row.render();
			this.#write(insertProperty(this.#yaml(), name, null));
			if (next) row.focusValue();
			return;
		}
		if (!name || name === row.key || taken) {
			if (taken) new Notice(`A property named "${name}" already exists`);
			row.keyInput.value = row.key;
			if (next) row.focusValue();
			return;
		}
		const old = row.key;
		row.key = name;
		this.#write(renameProperty(this.#yaml(), old, name));
		row.update(row.value);
		if (next) row.focusValue();
	}

	#dropPending(row: PropertyRow, focusKey?: string) {
		this.rows.remove(row);
		row.destroy();
		// An empty block the add command made for it goes too.
		if (this.host.getYaml() === "" && !this.rows.length) this.host.setYaml("");
		const target = (focusKey && this.rows.find((r) => r.key === focusKey)) || this.rows[this.rows.length - 1];
		if (target) target.el.focus();
		else this.addPropertyButtonEl.focus();
	}

	#remove(rows: PropertyRow[]) {
		const index = this.rows.indexOf(rows[0]);
		let yaml = this.#yaml();
		for (const row of rows) {
			if (row.pending) {
				this.rows.remove(row);
				row.destroy();
			} else yaml = removeProperty(yaml, row.key);
		}
		this.#select([]);
		this.#write(yaml);
		const left = this.rows.filter((r) => !rows.includes(r));
		const target = left[Math.min(index, left.length - 1)];
		if (target) target.el.focus();
		else if (this.containerEl.isConnected) this.addPropertyButtonEl.focus();
		else this.host.focusBody();
	}

	#changeType(row: PropertyRow, type: string) {
		const converted = convertValue(row.value, type);
		this.app.metadataTypeManager.setType(row.key, type);
		if (converted !== undefined && !same(converted, row.value)) this.setValue(row, converted);
		row.update(row.value);
	}

	showTypeMenu(row: PropertyRow, pos: { x: number; y: number }) {
		if (row.pending) return;
		const types = this.app.metadataTypeManager;
		const menu = new Menu();
		menu.addItem((item) => {
			item.setTitle("Property type").setIcon(types.getWidget(row.type).icon);
			const sub = item.setSubmenu();
			for (const widget of types.getTypesFor(row.key)) {
				sub.addItem((i) =>
					i
						.setTitle(widget.name())
						.setIcon(widget.icon)
						.setChecked(widget.type === row.type)
						.onClick(() => this.#changeType(row, widget.type)),
				);
			}
		});
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Remove")
				.setIcon("trash-2")
				.setWarning(true)
				.onClick(() => this.#remove([row])),
		);
		menu.onHide(() => {
			if (!this.containerEl.contains(document.activeElement)) row.el.focus();
		});
		menu.showAtPosition(pos);
	}

	#rowOf(target: EventTarget | null) {
		const el = (target as HTMLElement | null)?.closest?.(".metadata-property");
		return el ? this.rows.find((r) => r.el === el) : undefined;
	}

	#select(rows: PropertyRow[]) {
		for (const row of this.#selected) row.el.removeClass("is-selected");
		this.#selected = new Set(rows);
		for (const row of rows) row.el.addClass("is-selected");
	}

	// Focus coming up from the note: the last property.
	focusLast() {
		if (this.containerEl.hasClass("is-collapsed") || this.errorEl.isShown()) this.headingEl.focus();
		else if (this.rows.length) this.focusRow(this.rows.length - 1);
		else this.addPropertyButtonEl.focus();
	}

	focusRow(index: number) {
		this.rows[Math.max(0, Math.min(index, this.rows.length - 1))]?.el.focus();
	}

	#move(row: PropertyRow, delta: number, extend: boolean) {
		const index = this.rows.indexOf(row);
		const target = this.rows[index + delta];
		if (extend) {
			this.#anchor ??= row;
			const a = this.rows.indexOf(this.#anchor);
			const b = target ? index + delta : index;
			target?.el.focus();
			this.#select(this.rows.slice(Math.min(a, b), Math.max(a, b) + 1));
			return;
		}
		this.#anchor = null;
		if (target) target.el.focus();
		else if (delta > 0) this.addPropertyButtonEl.focus();
		else this.headingEl.focus();
	}

	#onKeydown(evt: KeyboardEvent) {
		if (evt.isComposing || evt.defaultPrevented) return;
		const target = evt.target as HTMLElement;
		const mod = Keymap.isModifier(evt, "Mod");
		const handled = () => {
			evt.preventDefault();
			evt.stopPropagation();
		};
		if (target === this.headingEl) {
			if (evt.key === "Enter" || evt.key === " ") {
				handled();
				this.#setCollapsed(!this.containerEl.hasClass("is-collapsed"));
			} else if (evt.key === "ArrowDown" && !this.containerEl.hasClass("is-collapsed")) {
				handled();
				if (this.rows.length) this.focusRow(0);
				else this.addPropertyButtonEl.focus();
			}
			return;
		}
		if (target === this.addPropertyButtonEl) {
			if (evt.key === "Enter" || evt.key === " ") {
				handled();
				this.addProperty();
			} else if (evt.key === "ArrowUp") {
				handled();
				if (this.rows.length) this.focusRow(this.rows.length - 1);
				else this.headingEl.focus();
			} else if (evt.key === "ArrowDown") {
				handled();
				this.host.focusBody();
			}
			return;
		}
		const row = this.#rowOf(target);
		if (!row) return;
		if (target !== row.el) {
			// Escape leaves a value for its property; the widget commits on blur.
			if (evt.key === "Escape" && target !== row.keyInput) {
				handled();
				row.el.focus();
			}
			return;
		}
		const key = evt.key;
		if (key === "ArrowDown" && evt.altKey) {
			handled();
			this.host.focusBody();
		} else if (key === "ArrowDown" || (key === "Tab" && !evt.shiftKey)) {
			handled();
			this.#move(row, 1, evt.shiftKey && key === "ArrowDown");
		} else if (key === "ArrowUp" || (key === "Tab" && evt.shiftKey)) {
			handled();
			this.#move(row, -1, evt.shiftKey && key === "ArrowUp");
		} else if (key === "ArrowLeft") {
			handled();
			row.focusKey();
		} else if (key === "ArrowRight" || key === "Enter") {
			handled();
			row.focusValue();
		} else if ((key === "Backspace" || key === "Delete") && mod) {
			handled();
			this.#remove(this.#selected.size ? this.rows.filter((r) => this.#selected.has(r)) : [row]);
		} else if (key.toLowerCase() === "a" && mod) {
			handled();
			this.#select(this.rows.filter((r) => !r.pending));
		} else if (key.toLowerCase() === "z" && mod) {
			handled();
			if (evt.shiftKey) this.host.redo?.();
			else this.host.undo?.();
		} else if (key === "Escape" && this.#selected.size) {
			handled();
			this.#select([]);
		}
	}

	// The type menu opens from a property's icon, and its context menu.
	#onPointer(evt: MouseEvent) {
		const row = this.#rowOf(evt.target);
		if (!row || row.pending) return;
		const target = evt.target as HTMLElement;
		const icon = target.closest(".metadata-property-icon");
		if ((evt.type === "contextmenu" && !row.valueEl.contains(target)) || (icon && evt.type === "click")) {
			evt.preventDefault();
			evt.stopPropagation();
			this.showTypeMenu(row, { x: evt.clientX, y: evt.clientY });
		}
	}
}
