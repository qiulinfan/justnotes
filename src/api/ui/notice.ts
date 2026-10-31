// One container per window: a notice shows in the focused window.
const containers = new WeakMap<Document, HTMLElement>();

// Obsidian's DOM: .notice-container > .notice (containerEl) > .notice-message
// (messageEl; noticeEl is its deprecated name).
export class Notice {
	noticeEl: HTMLElement;
	containerEl: HTMLElement;
	messageEl: HTMLElement;
	#timer: ReturnType<typeof setTimeout> | null = null;

	constructor(message: string | DocumentFragment, duration?: number) {
		const doc = activeDocument;
		let container = containers.get(doc);
		if (!container?.isConnected) containers.set(doc, (container = doc.body.createDiv("notice-container")));
		this.containerEl = container.createDiv("notice");
		this.messageEl = this.containerEl.createDiv("notice-message");
		this.noticeEl = this.messageEl;
		this.setMessage(message);
		this.containerEl.addEventListener("click", () => this.hide());
		const ms = duration ?? 4500;
		if (ms > 0) this.#timer = setTimeout(() => this.hide(), ms);
	}

	setMessage(message: string | DocumentFragment) {
		this.messageEl.setText(message);
		return this;
	}

	hide() {
		if (this.#timer) clearTimeout(this.#timer);
		this.containerEl.detach();
	}
}
