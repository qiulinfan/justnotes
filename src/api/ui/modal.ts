import type { App } from "../app";
import { Scope } from "../keymap";

export class Modal {
	app: App;
	scope: Scope;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	shouldRestoreSelection = true;
	#onCloseCallback: (() => any) | null = null;
	#restoreFocus: Element | null = null;
	isOpen = false;

	constructor(app: App) {
		this.app = app;
		this.scope = new Scope(app.scope);
		this.scope.register([], "Escape", () => {
			this.close();
			return false;
		});
		this.containerEl = createDiv("modal-container mod-dim");
		const bg = this.containerEl.createDiv("modal-bg");
		bg.addEventListener("click", () => this.close());
		this.modalEl = this.containerEl.createDiv("modal");
		const close = this.modalEl.createDiv("modal-close-button");
		close.addEventListener("click", () => this.close());
		const header = this.modalEl.createDiv("modal-header");
		this.titleEl = header.createDiv("modal-title");
		this.contentEl = this.modalEl.createDiv("modal-content");
	}

	open() {
		if (this.isOpen) return;
		this.isOpen = true;
		this.#restoreFocus = document.activeElement;
		document.body.appendChild(this.containerEl);
		this.app.keymap.pushScope(this.scope);
		this.onOpen();
	}

	close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.app.keymap.popScope(this.scope);
		this.containerEl.detach();
		this.onClose();
		this.#onCloseCallback?.();
		if (this.shouldRestoreSelection && this.#restoreFocus instanceof HTMLElement) this.#restoreFocus.focus();
	}

	onOpen(): void | Promise<void> {}

	onClose() {}

	setTitle(title: string) {
		this.titleEl.setText(title);
		return this;
	}

	setContent(content: string | DocumentFragment) {
		this.contentEl.setText(content);
		return this;
	}

	setCloseCallback(cb: () => any) {
		this.#onCloseCallback = cb;
		return this;
	}
}
