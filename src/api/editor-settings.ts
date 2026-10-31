import type { App } from "./app";

// justnotes' own editor settings (the Editor tab), kept per vault in
// localStorage `justnotes-editor`, never in Obsidian's app.json.
export type PastedImageFormat = "html" | "wikilink" | "markdown";

export interface EditorSettings {
	// 1 to 10; see selectionScrollSpeed in selection-scroll.ts.
	selectionScrollSpeed: number;
	// How a pasted or dropped image is written into the note.
	pastedImageFormat: PastedImageFormat;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { selectionScrollSpeed: 5, pastedImageFormat: "html" };

const FORMATS: PastedImageFormat[] = ["html", "wikilink", "markdown"];

// The saved settings over the defaults; a value that is out of range or of
// another type falls back to its default.
export function editorSettings(app: App): EditorSettings {
	const saved = app.loadLocalStorage("justnotes-editor") ?? {};
	const speed = Number(saved.selectionScrollSpeed);
	return {
		selectionScrollSpeed: Number.isFinite(speed) && speed >= 1 && speed <= 10 ? speed : DEFAULT_EDITOR_SETTINGS.selectionScrollSpeed,
		pastedImageFormat: FORMATS.includes(saved.pastedImageFormat) ? saved.pastedImageFormat : DEFAULT_EDITOR_SETTINGS.pastedImageFormat,
	};
}

export function setEditorSetting<K extends keyof EditorSettings>(app: App, key: K, value: EditorSettings[K]) {
	app.saveLocalStorage("justnotes-editor", { ...editorSettings(app), [key]: value });
}
