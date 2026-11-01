import { EditorView } from "@codemirror/view";
import type { App } from "./app";
import { appWindows } from "./dom";

// justnotes' own editor settings (the Editor tab), kept per vault in
// localStorage `justnotes-editor`, never in Obsidian's app.json.
export type PastedImageFormat = "html" | "wikilink" | "markdown";

export interface EditorSettings {
	// 1 to 10; see selectionScrollSpeed in selection-scroll.ts.
	selectionScrollSpeed: number;
	// How a pasted or dropped image is written into the note.
	pastedImageFormat: PastedImageFormat;
	// Notes' line height, LINE_HEIGHT_MIN to LINE_HEIGHT_MAX; the default is
	// Obsidian's --line-height-normal.
	lineHeight: number;
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = { selectionScrollSpeed: 5, pastedImageFormat: "html", lineHeight: 1.5 };
export const LINE_HEIGHT_MIN = 1;
export const LINE_HEIGHT_MAX = 2.5;

const FORMATS: PastedImageFormat[] = ["html", "wikilink", "markdown"];

// The saved settings over the defaults; a value that is out of range or of
// another type falls back to its default.
export function editorSettings(app: App): EditorSettings {
	const saved = app.loadLocalStorage("justnotes-editor") ?? {};
	const speed = Number(saved.selectionScrollSpeed);
	const lineHeight = Number(saved.lineHeight);
	return {
		selectionScrollSpeed: Number.isFinite(speed) && speed >= 1 && speed <= 10 ? speed : DEFAULT_EDITOR_SETTINGS.selectionScrollSpeed,
		pastedImageFormat: FORMATS.includes(saved.pastedImageFormat) ? saved.pastedImageFormat : DEFAULT_EDITOR_SETTINGS.pastedImageFormat,
		lineHeight: Number.isFinite(lineHeight) && lineHeight >= LINE_HEIGHT_MIN && lineHeight <= LINE_HEIGHT_MAX ? lineHeight : DEFAULT_EDITOR_SETTINGS.lineHeight,
	};
}

export function setEditorSetting<K extends keyof EditorSettings>(app: App, key: K, value: EditorSettings[K]) {
	app.saveLocalStorage("justnotes-editor", { ...editorSettings(app), [key]: value });
}

// The line height sets --line-height-normal on the body, which the editor,
// the reading view and rendered Markdown read (popouts mirror the body's
// style). At the default the variable is left to the theme.
export function applyLineHeight(app: App) {
	const { lineHeight } = editorSettings(app);
	const style = document.body.style;
	const before = style.getPropertyValue("--line-height-normal");
	if (lineHeight === DEFAULT_EDITOR_SETTINGS.lineHeight) style.removeProperty("--line-height-normal");
	else style.setProperty("--line-height-normal", String(lineHeight));
	if (style.getPropertyValue("--line-height-normal") !== before) remeasureEditors();
}

// CodeMirror does not notice a line height that changes alone: its height map
// keeps the old heights, so clicks and the cursor land on the wrong lines. It
// re-measures everything after a "refresh" (@codemirror/view 6's
// `viewState.mustMeasureContent`, what it sets itself once fonts load);
// recheck the name when upgrading @codemirror/view.
function remeasureEditors() {
	for (const win of appWindows()) {
		for (const el of Array.from(win.document.querySelectorAll<HTMLElement>(".cm-editor"))) {
			const view = EditorView.findFromDOM(el);
			const viewState = (view as unknown as { viewState?: { mustMeasureContent: boolean | string } } | null)?.viewState;
			if (!view || !viewState) continue;
			viewState.mustMeasureContent = "refresh";
			view.requestMeasure();
		}
	}
}
