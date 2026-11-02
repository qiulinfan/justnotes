import type { App } from "./app";
import { attempt, PromptModal } from "./ui/file-modals";
import { Notice } from "./ui/notice";
import type { TFile } from "./vault";

// Renaming a file from its title, as in Obsidian: the tab title bar's title
// and a note's inline title are edited in place, and "Rename file" (F2)
// focuses one of them.

// Characters Obsidian refuses in a file name (Windows' set, so a vault stays
// usable on every platform).
const ILLEGAL = /[*"\\/<>:|?]/;

// The path a file gets when its title is edited to `typed`. A title showing
// the whole name (a TeX or code file) is edited as the whole name; one
// showing the basename keeps the extension. Null when nothing changes; throws
// with the reason when the name cannot be used.
export function titleRenamePath(file: TFile, shown: string, typed: string): string | null {
	const name = typed.replace(/[\r\n]+/g, "").trim();
	if (!name || name === shown) return null;
	if (ILLEGAL.test(name)) throw new Error('File name cannot contain any of the following characters: * " \\ / < > : | ?');
	if (name.startsWith(".")) throw new Error("File name cannot start with a dot.");
	const full = shown === file.name && file.basename !== file.name;
	const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
	return `${dir}${name}${full || !file.extension ? "" : `.${file.extension}`}`;
}

// Renames `file` to what its title was edited to; a refused or failed rename
// says why. Returns whether the file was renamed.
export async function renameFromTitle(app: App, file: TFile, shown: string, typed: string) {
	let path: string | null;
	try {
		path = titleRenamePath(file, shown, typed);
	} catch (err) {
		new Notice((err as Error).message);
		return false;
	}
	if (!path || path === file.path) return false;
	const before = file.path;
	await attempt(() => app.fileManager.renameFile(file, path));
	return file.path !== before;
}

// The explorer's Rename dialog, for a title that is not shown.
export function promptRename(app: App, file: TFile, shown: string) {
	new PromptModal(app, "Rename", shown, (name) => renameFromTitle(app, file, shown, name)).open();
}

export interface TitleField {
	el: HTMLElement;
	// The text the title shows while not being edited.
	shown(): string;
	// The edited text, and putting text back.
	read(): string;
	write(text: string): void;
}

// Makes `field` rename `file()` when edited: Enter (or leaving it) renames,
// Escape puts the name back; both then call `done` (the note takes the
// focus), `cancelled` true for Escape. A name the vault refuses is put back.
export function bindTitleField(app: App, field: TitleField, file: () => TFile | null, done: (cancelled: boolean) => void) {
	let editing = false;
	let cancelled = false;
	field.el.addEventListener("focus", () => {
		editing = true;
		cancelled = false;
	});
	field.el.addEventListener("keydown", (evt) => {
		if (evt.isComposing) return;
		if (evt.key === "Enter" || evt.key === "Escape") {
			evt.preventDefault();
			evt.stopPropagation();
			if (evt.key === "Escape") cancelled = true;
			field.el.blur();
			done(cancelled);
		}
	});
	field.el.addEventListener("blur", async () => {
		if (!editing) return;
		editing = false;
		const target = file();
		const shown = field.shown();
		const typed = field.read();
		if (cancelled || !target) return void field.write(shown);
		const renamed = await renameFromTitle(app, target, shown, typed);
		// A rename updates the title through the view; anything else puts the
		// name back.
		if (!renamed) field.write(field.shown());
	});
}
