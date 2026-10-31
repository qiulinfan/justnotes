import type { App } from "./app";
import { appWindows } from "./dom";
import { setIcon } from "./icons";
import type { TAbstractFile, TFile, TFolder } from "./vault";

// What is being dragged inside the window, in the shape of Obsidian's private
// `app.dragManager.draggable`: plugins that accept drops read it (terminal
// 3.29 types the dragged files' paths), the editor turns it into links and
// the canvas into cards. A "link" drag (a link in rendered Markdown, an
// outline heading, an unresolved outgoing link) carries the link text and the
// path it resolves from.
export interface DragData {
	type: "file" | "folder" | "files" | "link" | "bookmarks";
	icon: string;
	title: string;
	source?: string;
	file?: TAbstractFile;
	files?: TAbstractFile[];
	linktext?: string;
	sourcePath?: string;
	// Bookmarks being dragged, as Obsidian's `{ item }` entries; `files`
	// holds the files and folders they point at.
	items?: { item: unknown }[];
}

// A transparent image hides Chromium's own drag image; the ghost below
// follows the pointer instead and can show what a drop would do.
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

export class DragManager {
	app: App;
	draggable: DragData | null = null;
	#ghostEl: HTMLElement | null = null;
	#actionEl: HTMLElement | null = null;
	#blank = new Image();
	// Ends the drag in progress.
	#end: (() => void) | null = null;

	constructor(app: App) {
		this.app = app;
		this.#blank.src = BLANK;
	}

	dragFile(_evt: DragEvent, file: TFile, source?: string): DragData {
		return { type: "file", icon: "lucide-file", title: file.extension === "md" ? file.basename : file.name, source, file };
	}

	dragFolder(_evt: DragEvent, folder: TFolder, source?: string): DragData {
		return { type: "folder", icon: "lucide-folder", title: folder.name, source, file: folder };
	}

	dragFiles(_evt: DragEvent, files: TAbstractFile[], source?: string): DragData {
		return { type: "files", icon: "lucide-files", title: `${files.length} files`, source, files };
	}

	dragLink(_evt: DragEvent, linktext: string, sourcePath: string, title?: string, source?: string): DragData {
		return { type: "link", icon: "lucide-link", title: title ?? linktext, source, linktext, sourcePath };
	}

	// Makes `el` a drag source: `get` gives what it drags, or null for none.
	handleDrag(el: HTMLElement, get: (evt: DragEvent) => DragData | null) {
		el.draggable = true;
		el.addEventListener("dragstart", (evt) => {
			const data = get(evt);
			if (data) this.onDragStart(evt, data);
		});
	}

	// Starts a drag of `data` from `evt`'s element; it ends with the drag.
	// The drag may start in a popout window and cross into another one, so
	// every app window's document is watched. A drop ends it once the drop's
	// dispatch is over, whatever the target did: a target may stop the event,
	// or re-render the dragged element (a bookmark moved), which then gets its
	// dragend outside every document.
	onDragStart(evt: DragEvent, data: DragData) {
		this.#end?.();
		this.draggable = data;
		if (evt.dataTransfer) {
			// A link's own drag data (its URL, the text) would be dropped as
			// text; the drop targets read `draggable` instead.
			evt.dataTransfer.clearData();
			evt.dataTransfer.effectAllowed = "all";
			evt.dataTransfer.setDragImage(this.#blank, 0, 0);
		}
		const ghost = evt.doc.body.createDiv("drag-ghost");
		const self = ghost.createDiv("drag-ghost-self");
		setIcon(self.createSpan(), data.icon);
		self.createSpan({ text: data.title });
		this.#actionEl = ghost.createDiv("drag-ghost-action");
		this.#actionEl.hide();
		this.#ghostEl = ghost;
		this.#move(evt);
		const docs = appWindows().map((win) => win.document);
		// Each target under the pointer names its action again in its own
		// dragover, which runs after this capturing listener.
		const move = (e: DragEvent) => {
			this.setAction(null);
			this.#move(e);
		};
		const dropped = () => window.setTimeout(end);
		const end = () => {
			if (this.#end !== end) return;
			this.#end = null;
			for (const doc of docs) {
				doc.removeEventListener("dragover", move, true);
				doc.removeEventListener("dragend", end, true);
				doc.removeEventListener("drop", dropped, true);
			}
			this.draggable = null;
			ghost.detach();
			this.#ghostEl = this.#actionEl = null;
		};
		for (const doc of docs) {
			doc.addEventListener("dragover", move, true);
			doc.addEventListener("dragend", end, true);
			doc.addEventListener("drop", dropped, true);
		}
		this.#end = end;
	}

	// What dropping here would do, shown on the ghost; null hides it.
	setAction(action: string | null) {
		if (!this.#actionEl) return;
		this.#actionEl.setText(action ?? "");
		this.#actionEl.toggle(!!action);
	}

	// The files a drag carries, folders included.
	static files(data: DragData | null): TAbstractFile[] {
		if (!data) return [];
		return data.files ?? (data.file ? [data.file] : []);
	}

	// The ghost follows the pointer into the window it is over.
	#move(evt: DragEvent) {
		if (!this.#ghostEl || (evt.clientX === 0 && evt.clientY === 0)) return;
		const body = evt.doc.body;
		if (this.#ghostEl.parentNode !== body) body.appendChild(this.#ghostEl);
		this.#ghostEl.style.left = `${evt.clientX + 10}px`;
		this.#ghostEl.style.top = `${evt.clientY + 10}px`;
	}
}
