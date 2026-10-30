import type { App } from "../app";
import { Scope } from "../keymap";
import { prepareFuzzySearch, renderResults, type SearchResult } from "../util";
import type { EditorPosition } from "../editor";
import { Modal } from "./modal";

interface Owner<T> {
	renderSuggestion(value: T, el: HTMLElement): any;
	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): any;
}

// Obsidian's internal chooser: the rendered list with a keyboard selection.
export class Suggestions<T> {
	owner: Owner<T>;
	containerEl: HTMLElement;
	values: T[] = [];
	suggestions: HTMLElement[] = [];
	selectedItem = 0;

	constructor(owner: Owner<T>, containerEl: HTMLElement, scope: Scope) {
		this.owner = owner;
		this.containerEl = containerEl;
		containerEl.on("click", ".suggestion-item", (evt, el) => this.onSuggestionClick(evt as MouseEvent, el));
		containerEl.on("mousemove", ".suggestion-item", (evt, el) => this.onSuggestionMouseover(evt as MouseEvent, el));
		scope.register([], "ArrowUp", (evt) => {
			if (!evt.isComposing) {
				this.moveUp(evt);
				return false;
			}
		});
		scope.register([], "ArrowDown", (evt) => {
			if (!evt.isComposing) {
				this.moveDown(evt);
				return false;
			}
		});
		scope.register([], "Enter", (evt) => {
			if (!evt.isComposing) {
				this.useSelectedItem(evt);
				return false;
			}
		});
	}

	setSuggestions(values: T[]) {
		this.containerEl.empty();
		this.values = values;
		this.suggestions = values.map((v) => {
			const el = this.containerEl.createDiv("suggestion-item");
			this.owner.renderSuggestion(v, el);
			return el;
		});
		this.setSelectedItem(0, null);
	}

	onSuggestionClick(evt: MouseEvent, el: HTMLElement) {
		evt.preventDefault();
		const i = this.suggestions.indexOf(el);
		this.setSelectedItem(i, evt);
		this.useSelectedItem(evt);
	}

	onSuggestionMouseover(evt: MouseEvent, el: HTMLElement) {
		this.setSelectedItem(this.suggestions.indexOf(el), evt);
	}

	moveUp(evt: KeyboardEvent) {
		this.setSelectedItem(this.selectedItem - 1, evt);
	}

	moveDown(evt: KeyboardEvent) {
		this.setSelectedItem(this.selectedItem + 1, evt);
	}

	setSelectedItem(index: number, evt: Event | null) {
		const n = this.suggestions.length;
		if (n === 0) return;
		const i = ((index % n) + n) % n;
		this.suggestions[this.selectedItem]?.removeClass("is-selected");
		this.selectedItem = i;
		const el = this.suggestions[i];
		el.addClass("is-selected");
		if (evt instanceof KeyboardEvent) el.scrollIntoView({ block: "nearest" });
	}

	useSelectedItem(evt?: MouseEvent | KeyboardEvent) {
		const value = this.values[this.selectedItem];
		if (value !== undefined) this.owner.selectSuggestion(value, evt ?? new KeyboardEvent("keydown"));
		return value !== undefined;
	}
}

export interface Instruction {
	command: string;
	purpose: string;
}

function renderInstructions(el: HTMLElement, instructions: Instruction[]) {
	el.empty();
	for (const i of instructions) {
		const item = el.createDiv("prompt-instruction");
		item.createSpan({ cls: "prompt-instruction-command", text: i.command });
		item.createSpan({ text: i.purpose });
	}
}

export abstract class SuggestModal<T> extends Modal {
	limit = 100;
	emptyStateText = "No results found.";
	inputEl: HTMLInputElement;
	resultContainerEl: HTMLElement;
	instructionsEl: HTMLElement;
	chooser: Suggestions<T>;

	constructor(app: App) {
		super(app);
		this.containerEl.addClass("mod-suggestion");
		this.modalEl.addClass("prompt");
		this.modalEl.empty();
		const inputWrap = this.modalEl.createDiv("prompt-input-container");
		this.inputEl = inputWrap.createEl("input", { cls: "prompt-input", type: "text" });
		this.resultContainerEl = this.modalEl.createDiv("prompt-results");
		this.instructionsEl = this.modalEl.createDiv("prompt-instructions");
		this.chooser = new Suggestions<T>(this, this.resultContainerEl, this.scope);
		this.inputEl.addEventListener("input", () => this.onInput());
	}

	setPlaceholder(placeholder: string) {
		this.inputEl.placeholder = placeholder;
	}

	setInstructions(instructions: Instruction[]) {
		renderInstructions(this.instructionsEl, instructions);
	}

	onOpen() {
		this.inputEl.focus();
		this.onInput();
	}

	async onInput() {
		const values = (await this.getSuggestions(this.inputEl.value)).slice(0, this.limit);
		if (values.length === 0) {
			this.chooser.setSuggestions([]);
			this.onNoSuggestion();
			return;
		}
		this.chooser.setSuggestions(values);
	}

	onNoSuggestion() {
		this.resultContainerEl.createDiv({ cls: "suggestion-empty", text: this.emptyStateText });
	}

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent) {
		this.close();
		this.onChooseSuggestion(value, evt);
	}

	selectActiveSuggestion(evt: MouseEvent | KeyboardEvent) {
		this.chooser.useSelectedItem(evt);
	}

	abstract getSuggestions(query: string): T[] | Promise<T[]>;
	abstract renderSuggestion(value: T, el: HTMLElement): any;
	abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): any;
}

export interface FuzzyMatch<T> {
	item: T;
	match: SearchResult;
}

export abstract class FuzzySuggestModal<T> extends SuggestModal<FuzzyMatch<T>> {
	getSuggestions(query: string): FuzzyMatch<T>[] {
		const search = prepareFuzzySearch(query.trim());
		const results: FuzzyMatch<T>[] = [];
		for (const item of this.getItems()) {
			const match = search(this.getItemText(item));
			if (match) results.push({ item, match });
		}
		if (query.trim()) results.sort((a, b) => b.match.score - a.match.score);
		return results;
	}

	renderSuggestion(item: FuzzyMatch<T>, el: HTMLElement) {
		renderResults(el, this.getItemText(item.item), item.match);
	}

	onChooseSuggestion(item: FuzzyMatch<T>, evt: MouseEvent | KeyboardEvent) {
		this.onChooseItem(item.item, evt);
	}

	abstract getItems(): T[];
	abstract getItemText(item: T): string;
	abstract onChooseItem(item: T, evt: MouseEvent | KeyboardEvent): void;
}

// A floating list anchored to a point, used by editor and input suggests.
export abstract class PopoverSuggest<T> {
	app: App;
	scope: Scope;
	suggestEl: HTMLElement;
	suggestions: Suggestions<T>;
	isOpen = false;

	constructor(app: App, scope?: Scope) {
		this.app = app;
		this.scope = scope ?? new Scope(app.scope);
		this.suggestEl = createDiv("suggestion-container");
		const list = this.suggestEl.createDiv("suggestion");
		this.suggestions = new Suggestions<T>(this, list, this.scope);
		this.scope.register([], "Escape", () => {
			this.close();
			return false;
		});
		this.suggestEl.addEventListener("mousedown", (evt) => evt.preventDefault());
	}

	open() {
		if (this.isOpen) return;
		this.isOpen = true;
		document.body.appendChild(this.suggestEl);
		this.app.keymap.pushScope(this.scope);
	}

	close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.app.keymap.popScope(this.scope);
		this.suggestEl.detach();
	}

	reposition(rect: { left: number; right: number; top: number; bottom: number }) {
		const el = this.suggestEl;
		el.style.left = `${Math.min(rect.left, window.innerWidth - el.offsetWidth - 8)}px`;
		const below = rect.bottom + 4;
		const fitsBelow = below + el.offsetHeight < window.innerHeight;
		el.style.top = `${fitsBelow ? below : Math.max(4, rect.top - el.offsetHeight - 4)}px`;
	}

	abstract renderSuggestion(value: T, el: HTMLElement): any;
	abstract selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent): any;
}

export interface EditorSuggestTriggerInfo {
	start: EditorPosition;
	end: EditorPosition;
	query: string;
}

export abstract class EditorSuggest<T> extends PopoverSuggest<T> {
	context: (EditorSuggestTriggerInfo & { editor: any; file: any }) | null = null;
	limit = 100;
	instructionsEl: HTMLElement | null = null;

	setInstructions(instructions: Instruction[]) {
		this.instructionsEl ??= this.suggestEl.createDiv("prompt-instructions");
		renderInstructions(this.instructionsEl, instructions);
	}

	// Ask this suggest whether it applies at the cursor, then show or hide.
	async trigger(editor: any, file: any, _openIfClosed?: boolean) {
		const cursor = editor.getCursor();
		const info = this.onTrigger(cursor, editor, file);
		if (!info) {
			this.close();
			return false;
		}
		this.context = { ...info, editor, file };
		const context = this.context;
		const values = await this.getSuggestions(context);
		if (this.context !== context) return true;
		if (!values || values.length === 0) {
			this.close();
			return true;
		}
		this.showSuggestions(values.slice(0, this.limit));
		return true;
	}

	showSuggestions(values: T[]) {
		this.suggestions.setSuggestions(values);
		this.open();
		const cm = this.context?.editor?.cm;
		if (cm) {
			const pos = this.context!.editor.posToOffset(this.context!.start);
			const coords = cm.coordsAtPos(pos);
			if (coords) this.reposition(coords);
		}
	}

	close() {
		super.close();
		this.context = null;
	}

	abstract onTrigger(cursor: EditorPosition, editor: any, file: any): EditorSuggestTriggerInfo | null;
	abstract getSuggestions(context: any): T[] | Promise<T[]>;
}

export abstract class AbstractInputSuggest<T> extends PopoverSuggest<T> {
	limit = 100;
	textInputEl: HTMLInputElement | HTMLDivElement;
	#onSelect: ((value: T, evt: MouseEvent | KeyboardEvent) => any) | null = null;

	constructor(app: App, textInputEl: HTMLInputElement | HTMLDivElement) {
		super(app);
		this.textInputEl = textInputEl;
		textInputEl.addEventListener("input", () => this.#update());
		textInputEl.addEventListener("focus", () => this.#update());
		textInputEl.addEventListener("blur", () => this.close());
	}

	getValue() {
		const el = this.textInputEl;
		return el instanceof HTMLInputElement ? el.value : (el.textContent ?? "");
	}

	setValue(value: string) {
		const el = this.textInputEl;
		if (el instanceof HTMLInputElement) el.value = value;
		else el.textContent = value;
	}

	async #update() {
		const values = (await this.getSuggestions(this.getValue())).slice(0, this.limit);
		if (values.length === 0) return this.close();
		this.suggestions.setSuggestions(values);
		this.open();
		this.reposition(this.textInputEl.getBoundingClientRect());
	}

	selectSuggestion(value: T, evt: MouseEvent | KeyboardEvent) {
		this.#onSelect?.(value, evt);
	}

	onSelect(cb: (value: T, evt: MouseEvent | KeyboardEvent) => any) {
		this.#onSelect = cb;
		return this;
	}

	abstract getSuggestions(query: string): T[] | Promise<T[]>;
}
