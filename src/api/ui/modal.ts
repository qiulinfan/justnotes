import type { App } from "../app";
import { setIcon } from "../icons";
import { Scope } from "../keymap";

export class Modal {
	app: App;
	scope: Scope;
	containerEl: HTMLElement;
	modalEl: HTMLElement;
	titleEl: HTMLElement;
	contentEl: HTMLElement;
	shouldRestoreSelection = true;
	isOpen = false;
	#onCloseCallback: (() => any) | null = null;
	#restoreFocus: Element | null = null;
	#ranges: Range[] = [];

	constructor(app: App) {
		this.app = app;
		// Unlike a popover suggest's, a modal's scope has no parent: keys it does
		// not handle reach no app hotkey or command, so typing in the modal never
		// acts on the note behind it.
		this.scope = new Scope();
		this.scope.register([], "Escape", () => {
			this.close();
			return false;
		});
		this.containerEl = createDiv("modal-container");
		const bg = this.containerEl.createDiv("modal-bg");
		bg.addEventListener("click", () => this.close());
		this.modalEl = this.containerEl.createDiv("modal");
		// Obsidian 1.14 calls it modal-header-button; older plugins look for
		// modal-close-button (terminal clicks it to close its own modals).
		const close = this.modalEl.createDiv("modal-close-button modal-header-button mod-raised clickable-icon");
		setIcon(close, "x");
		close.addEventListener("click", () => this.close());
		const header = this.modalEl.createDiv("modal-header");
		this.titleEl = header.createDiv("modal-title");
		this.contentEl = this.modalEl.createDiv("modal-content");
	}

	open() {
		if (this.isOpen) return;
		this.isOpen = true;
		this.#restoreFocus = document.activeElement;
		const selection = window.getSelection();
		this.#ranges = [];
		if (this.shouldRestoreSelection && selection) {
			for (let i = 0; i < selection.rangeCount; i++) this.#ranges.push(selection.getRangeAt(i).cloneRange());
		}
		document.body.appendChild(this.containerEl);
		this.containerEl.addClass("mod-dim");
		this.app.keymap.pushScope(this.scope);
		this.onOpen();
		// Keys the modal does not handle must not keep editing the note behind it.
		const active = document.activeElement;
		if (this.isOpen && active instanceof HTMLElement && !this.containerEl.contains(active)) active.blur();
	}

	close() {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.app.keymap.popScope(this.scope);
		this.containerEl.detach();
		this.containerEl.removeClass("mod-dim");
		this.onClose();
		this.#onCloseCallback?.();
		if (this.shouldRestoreSelection) this.#restore();
	}

	#restore() {
		const el = this.#restoreFocus;
		if (!(el instanceof HTMLElement) || !el.isConnected) return;
		el.focus();
		// CodeMirror restores its own selection on focus; saved DOM ranges
		// could point into lines it has redrawn since.
		if (el.closest(".cm-editor")) return;
		const selection = window.getSelection();
		if (!selection || !this.#ranges.every((r) => r.startContainer.isConnected && r.endContainer.isConnected)) return;
		selection.removeAllRanges();
		for (const range of this.#ranges) selection.addRange(range);
	}

	onHistoryBack() {
		this.close();
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
