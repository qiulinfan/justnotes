// The property widgets of app.metadataTypeManager.registeredTypeWidgets:
// the value half of a row in the properties editor, with Obsidian's classes
// (metadata-input-longtext, metadata-input-number, metadata-input-checkbox,
// multi-select-container, ...). A widget calls ctx.onChange with the new
// value when an edit is done (blur, Enter, a pick), never per keystroke.
import type { App } from "./app";
import { setIcon } from "./icons";
import { Keymap } from "./keymap";
import { searchTag } from "./live-preview";
import { type PropertyRenderContext, type PropertyWidget, type PropertyWidgetComponent, validateType } from "./metadata-types";
import { AbstractInputSuggest } from "./ui/suggest";

const WIKILINK = /^\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]$/;
const URL_TEXT = /^[a-z][\w+.-]*:\/\/\S+$/i;

// A text that is one link: what it shows and what opening it does.
function linkOf(app: App, text: string, sourcePath: string): { label: string; external: boolean; open(evt: MouseEvent): void } | null {
	const m = WIKILINK.exec(text.trim());
	if (m) {
		const target = `${m[1]}${m[2] ?? ""}`;
		return { label: m[3] || target, external: false, open: (evt) => app.workspace.openLinkText(target, sourcePath, Keymap.isModEvent(evt)) };
	}
	if (URL_TEXT.test(text.trim())) return { label: text.trim(), external: true, open: () => window.open(text.trim(), "_blank") };
	return null;
}

// Text fields are form controls, never contenteditable: the block sits in
// the editor's content, and a nested editing host lets select-all and the
// selection escape into the note.
function caret(el: HTMLInputElement | HTMLTextAreaElement, at: "start" | "end" = "end") {
	el.focus();
	const pos = at === "start" ? 0 : el.value.length;
	el.setSelectionRange(pos, pos);
}

// A one-line text that wraps: the textarea grows with its content.
function fit(el: HTMLTextAreaElement) {
	el.style.height = "auto";
	el.style.height = `${el.scrollHeight}px`;
}

function renderText(el: HTMLElement, value: unknown, ctx: PropertyRenderContext): PropertyWidgetComponent {
	const initial = value === null || value === undefined ? "" : String(value);
	const input = el.createEl("textarea", { cls: "metadata-input-longtext", attr: { rows: 1, placeholder: "Empty", spellcheck: "false" } });
	input.value = initial;
	input.addEventListener("input", () => fit(input));
	requestAnimationFrame(() => fit(input));
	const link = linkOf(ctx.app, initial, ctx.sourcePath);
	let linkEl: HTMLElement | null = null;
	if (link) {
		linkEl = el.createDiv("metadata-link");
		const inner = linkEl.createDiv({ cls: `metadata-link-inner ${link.external ? "external-link" : "internal-link"}`, text: link.label });
		inner.addEventListener("click", (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			link.open(evt);
		});
		input.hide();
		// A click beside the link edits the text.
		el.addEventListener("click", (evt) => {
			if (evt.target === inner) return;
			showInput();
			caret(input);
		});
	}
	const showInput = () => {
		linkEl?.hide();
		input.show();
	};
	input.addEventListener("focus", showInput);
	input.addEventListener("blur", () => {
		const text = input.value.replace(/\n/g, " ");
		if (text !== initial) ctx.onChange(text === "" ? null : typeof value === "number" && Number(text) === value ? value : text);
		else if (linkEl) {
			input.hide();
			linkEl.show();
		}
	});
	input.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter" || evt.isComposing) return;
		evt.preventDefault();
		ctx.blur();
	});
	return {
		focus: (at) => {
			showInput();
			caret(input, at);
		},
	};
}

class ValueSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		el: HTMLInputElement,
		readonly values: () => string[],
		readonly taken: () => string[],
	) {
		super(app, el);
	}

	// Only while typing, with what was typed first, so Enter keeps it.
	getSuggestions(query: string) {
		const typed = query.trim();
		const q = typed.toLowerCase().replace(/^#/, "");
		if (!q) return [];
		const taken = new Set(this.taken().map((t) => t.toLowerCase()));
		const values = this.values().filter((v) => !taken.has(v.toLowerCase()) && v.toLowerCase().includes(q));
		return values.some((v) => v.toLowerCase() === q) ? values : [typed, ...values];
	}

	renderSuggestion(value: string, el: HTMLElement) {
		el.setText(value);
	}
}

// The values a property has across the vault, for its suggestions.
function vaultValues(app: App, key: string, tags: boolean): string[] {
	if (tags) return Object.keys(app.metadataCache.getTags()).map((t) => t.replace(/^#/, ""));
	return app.metadataCache.getFrontmatterPropertyValuesForKey(key);
}

function renderList(el: HTMLElement, value: unknown, ctx: PropertyRenderContext, tags: boolean): PropertyWidgetComponent {
	const items: unknown[] = Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined) : value === null || value === undefined || value === "" ? [] : [value];
	const container = el.createDiv("multi-select-container");
	const commit = () => ctx.onChange(items.length ? [...items] : null);
	const clean = (text: string) => (tags ? text.trim().replace(/^#/, "") : text.trim());
	const add = (text: string) => {
		const parts = tags ? text.split(/[,\s]+/) : [text];
		let added = false;
		for (const part of parts.map(clean).filter(Boolean)) {
			items.push(part);
			added = true;
		}
		return added;
	};
	items.forEach((item, i) => {
		const text = String(item);
		const pill = container.createDiv({ cls: "multi-select-pill", attr: { tabindex: 0 } });
		const content = pill.createDiv("multi-select-pill-content").createSpan({ text });
		const link = tags ? null : linkOf(ctx.app, text, ctx.sourcePath);
		if (tags || link) content.addClass(tags ? "tag" : link!.external ? "external-link" : "internal-link");
		content.addEventListener("click", (evt) => {
			evt.stopPropagation();
			if (tags) searchTag(ctx.app, `#${text}`);
			else link?.open(evt);
		});
		// A double click takes the item back into the input for editing.
		pill.addEventListener("dblclick", (evt) => {
			evt.preventDefault();
			items.splice(i, 1);
			input.value = text;
			commit();
		});
		const remove = pill.createDiv("multi-select-pill-remove-button");
		setIcon(remove, "x");
		remove.addEventListener("click", (evt) => {
			evt.stopPropagation();
			items.splice(i, 1);
			commit();
		});
		pill.addEventListener("keydown", (evt) => {
			if (evt.key !== "Backspace" && evt.key !== "Delete") return;
			evt.preventDefault();
			evt.stopPropagation();
			items.splice(i, 1);
			commit();
		});
	});
	const input = container.createEl("input", { cls: "multi-select-input", attr: { type: "text", placeholder: items.length ? "" : "Empty", spellcheck: "false" } });
	const suggest = new ValueSuggest(
		ctx.app,
		input,
		() => vaultValues(ctx.app, ctx.key, tags),
		() => items.map(String),
	);
	suggest.onSelect((picked) => {
		suggest.close();
		input.value = "";
		if (add(picked)) commit();
	});
	input.addEventListener("keydown", (evt) => {
		// A suggestion picked with Enter took the key already.
		if (evt.isComposing || evt.defaultPrevented) return;
		const text = input.value;
		if (evt.key === "Enter") {
			evt.preventDefault();
			if (!text.trim()) return ctx.blur();
			input.value = "";
			if (add(text)) commit();
		} else if (evt.key === "Backspace" && !text && items.length) {
			evt.preventDefault();
			(container.querySelectorAll<HTMLElement>(".multi-select-pill")[items.length - 1] ?? input).focus();
		} else if (tags && (evt.key === "," || evt.key === " ") && text.trim()) {
			evt.preventDefault();
			input.value = "";
			if (add(text)) commit();
		}
	});
	input.addEventListener("blur", () => {
		const text = input.value;
		if (!text.trim()) return;
		input.value = "";
		if (add(text)) commit();
	});
	container.addEventListener("click", (evt) => {
		if (evt.target === container) caret(input);
	});
	return { focus: (at) => caret(input, at), unload: () => suggest.close() };
}

function renderInput(el: HTMLElement, value: unknown, ctx: PropertyRenderContext, type: "number" | "date" | "datetime"): PropertyWidgetComponent {
	const input = el.createEl("input", {
		cls: type === "number" ? "metadata-input metadata-input-number" : `metadata-input metadata-input-text mod-${type}`,
		attr: { type: type === "datetime" ? "datetime-local" : type, placeholder: "Empty" },
	});
	if (type === "datetime") input.step = "1";
	const shown = (v: unknown) => {
		if (v === null || v === undefined) return "";
		if (type === "datetime" && typeof v === "string" && /^\d{4}-\d\d-\d\d$/.test(v)) return `${v}T00:00`;
		return String(v);
	};
	const initial = shown(value);
	input.value = initial;
	let committed = initial;
	const commit = () => {
		const text = input.value.trim();
		if (text === committed) return;
		committed = text;
		if (!text) return ctx.onChange(null);
		if (type === "number") {
			const n = Number(text);
			if (Number.isFinite(n)) ctx.onChange(n);
			return;
		}
		ctx.onChange(type === "datetime" && /T\d\d:\d\d$/.test(text) ? `${text}:00` : text);
	};
	input.addEventListener("change", commit);
	input.addEventListener("blur", commit);
	input.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter") return;
		evt.preventDefault();
		commit();
		ctx.blur();
	});
	return { focus: () => input.focus() };
}

function renderCheckbox(el: HTMLElement, value: unknown, ctx: PropertyRenderContext): PropertyWidgetComponent {
	const input = el.createEl("input", { cls: "metadata-input-checkbox", attr: { type: "checkbox" } });
	input.checked = value === true;
	input.indeterminate = value === null || value === undefined;
	input.addEventListener("change", () => ctx.onChange(input.checked));
	input.addEventListener("keydown", (evt) => {
		if (evt.key !== "Enter") return;
		evt.preventDefault();
		input.checked = !input.checked;
		ctx.onChange(input.checked);
	});
	return { focus: () => input.focus() };
}

function renderUnknown(el: HTMLElement, value: unknown): PropertyWidgetComponent {
	const text = el.createDiv({ cls: "metadata-input-longtext", text: JSON.stringify(value), attr: { tabindex: 0 } });
	return { focus: () => text.focus() };
}

function widget(type: string, icon: string, name: string, render: PropertyWidget["render"], reservedKeys?: string[]): PropertyWidget {
	return { type, icon, name: () => name, validate: (v) => validateType(type, v), render, reservedKeys };
}

export function builtInWidgets(): PropertyWidget[] {
	return [
		widget("text", "lucide-text", "Text", renderText),
		widget("multitext", "lucide-list", "List", (el, v, ctx) => renderList(el, v, ctx, false)),
		widget("number", "lucide-binary", "Number", (el, v, ctx) => renderInput(el, v, ctx, "number")),
		widget("checkbox", "lucide-check-square", "Checkbox", renderCheckbox),
		widget("date", "lucide-calendar", "Date", (el, v, ctx) => renderInput(el, v, ctx, "date")),
		widget("datetime", "lucide-clock", "Date & time", (el, v, ctx) => renderInput(el, v, ctx, "datetime")),
		widget("aliases", "lucide-forward", "Aliases", (el, v, ctx) => renderList(el, v, ctx, false), ["aliases"]),
		widget("tags", "lucide-tags", "Tags", (el, v, ctx) => renderList(el, v, ctx, true), ["tags"]),
		widget("unknown", "lucide-file-question", "Unknown", renderUnknown),
	];
}
