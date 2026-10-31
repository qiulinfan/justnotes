import type { App } from "./app";
import { setIcon } from "./icons";
import type { TAbstractFile, TFile, TFolder } from "./vault";

// What is being dragged inside the window, in the shape of Obsidian's private
// `app.dragManager.draggable`: plugins that accept drops read it (terminal
// 3.29 types the dragged files' paths), and the editor turns it into links.
export interface DragData {
	type: "file" | "folder" | "files" | "bookmarks";
	icon: string;
	title: string;
	source?: string;
	file?: TAbstractFile;
	files?: TAbstractFile[];
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

	// Starts a drag of `data` from `evt`'s element; it ends with the drag.
	onDragStart(evt: DragEvent, data: DragData) {
		this.draggable = data;
		if (evt.dataTransfer) {
			evt.dataTransfer.effectAllowed = "all";
			evt.dataTransfer.setDragImage(this.#blank, 0, 0);
		}
		const ghost = document.body.createDiv("drag-ghost");
		const self = ghost.createDiv("drag-ghost-self");
		setIcon(self.createSpan(), data.icon);
		self.createSpan({ text: data.title });
		this.#actionEl = ghost.createDiv("drag-ghost-action");
		this.#actionEl.hide();
		this.#ghostEl = ghost;
		this.#move(evt);
		const doc = document;
		// Each target under the pointer names its action again in its own
		// dragover, which runs after this capturing listener.
		const move = (e: DragEvent) => {
			this.setAction(null);
			this.#move(e);
		};
		const end = () => {
			doc.removeEventListener("dragover", move, true);
			doc.removeEventListener("dragend", end, true);
			doc.removeEventListener("drop", end);
			this.draggable = null;
			this.#ghostEl?.detach();
			this.#ghostEl = this.#actionEl = null;
		};
		doc.addEventListener("dragover", move, true);
		doc.addEventListener("dragend", end, true);
		// A drop handler may stop the event; the drag still ends with dragend.
		doc.addEventListener("drop", end);
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

	#move(evt: DragEvent) {
		if (!this.#ghostEl || (evt.clientX === 0 && evt.clientY === 0)) return;
		this.#ghostEl.style.left = `${evt.clientX + 10}px`;
		this.#ghostEl.style.top = `${evt.clientY + 10}px`;
	}
}
