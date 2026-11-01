import { EditorView } from "@codemirror/view";
import type { App } from "./app";
import { appWindows } from "./dom";
import { refreshLivePreview } from "./live-preview";

// justnotes' own editor settings (the Editor tab), kept per vault in
// localStorage `justnotes-editor`, never in Obsidian's app.json.
export type PastedImageFormat = "html" | "wikilink" | "markdown";

export interface EditorSettings {
	// 1 to 10; see selectionScrollSpeed in selection-scroll.ts.
	selectionScrollSpeed: number;
	// How a pasted or dropped image is written into the note.
	pastedImageFormat: PastedImageFormat;
	// Notes' line height; the default is Obsidian's --line-height-normal.
	lineHeight: number;
	// Fenced code in Live Preview: Typora's box (code-fences.ts) or Obsidian's
	// fence lines shown while the cursor is in the block.
	codeBlockStyle: "typora" | "obsidian";
	// Code blocks' font size in percent of the text's; the default is
	// Obsidian's --code-size (0.875em).
	codeFontSize: number;
	codeLineNumbers: boolean;
	// The box's language field: always, or only while the cursor is in the block.
	codeLanguageField: "always" | "editing";
	// Block math in Live Preview with the cursor inside: only its source, as
	// Obsidian shows it, or the source with the rendered math below, as Typora.
	mathBlockStyle: "obsidian" | "typora";
	// Display math's size in percent.
	mathSize: number;
	mathAlign: "center" | "left";
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
	selectionScrollSpeed: 5,
	pastedImageFormat: "html",
	lineHeight: 1.5,
	codeBlockStyle: "typora",
	codeFontSize: 87.5,
	codeLineNumbers: false,
	codeLanguageField: "always",
	mathBlockStyle: "obsidian",
	mathSize: 100,
	mathAlign: "center",
};

// The range of each numeric setting, the choices of each other one.
export const EDITOR_SETTING_RANGES = {
	selectionScrollSpeed: [1, 10],
	lineHeight: [1, 2.5],
	codeFontSize: [70, 130],
	mathSize: [70, 200],
} as const;

const CHOICES: { [K in keyof EditorSettings]?: readonly EditorSettings[K][] } = {
	pastedImageFormat: ["html", "wikilink", "markdown"],
	codeBlockStyle: ["typora", "obsidian"],
	codeLanguageField: ["always", "editing"],
	mathBlockStyle: ["obsidian", "typora"],
	mathAlign: ["center", "left"],
	codeLineNumbers: [true, false],
};

// The saved settings over the defaults; a value that is out of range or of
// another type falls back to its default.
export function editorSettings(app: App): EditorSettings {
	const saved = app.loadLocalStorage("justnotes-editor") ?? {};
	const out: Record<string, unknown> = { ...DEFAULT_EDITOR_SETTINGS };
	for (const [key, [min, max]] of Object.entries(EDITOR_SETTING_RANGES)) {
		const n = Number(saved[key]);
		if (saved[key] !== null && Number.isFinite(n) && n >= min && n <= max) out[key] = n;
	}
	for (const [key, choices] of Object.entries(CHOICES)) {
		if ((choices as readonly unknown[]).includes(saved[key])) out[key] = saved[key];
	}
	return out as unknown as EditorSettings;
}

// Saves one setting and applies it to every window and editor.
export function setEditorSetting<K extends keyof EditorSettings>(app: App, key: K, value: EditorSettings[K]) {
	app.saveLocalStorage("justnotes-editor", { ...editorSettings(app), [key]: value });
	applyEditorSettings(app);
}

// What the settings change outside the editor's own extensions, which read
// editorSettings(app) when they run: CSS variables and classes on the body,
// which the editor, the reading view and rendered Markdown read (popouts
// mirror the body's style and classes). A variable at its default is left to
// the theme. Then every editor re-measures and rebuilds its Live Preview.
export function applyEditorSettings(app: App) {
	const s = editorSettings(app);
	const body = document.body;
	const variable = (name: string, value: number, fallback: number, unit = "") => {
		if (value === fallback) body.style.removeProperty(name);
		else body.style.setProperty(name, `${value}${unit}`);
	};
	variable("--line-height-normal", s.lineHeight, DEFAULT_EDITOR_SETTINGS.lineHeight);
	variable("--code-block-size", s.codeFontSize, DEFAULT_EDITOR_SETTINGS.codeFontSize, "%");
	variable("--math-block-size", s.mathSize, DEFAULT_EDITOR_SETTINGS.mathSize, "%");
	body.toggleClass("code-block-line-numbers", s.codeLineNumbers);
	body.toggleClass("code-language-while-editing", s.codeLanguageField === "editing");
	body.toggleClass("math-block-align-left", s.mathAlign === "left");
	refreshEditors();
}

// CodeMirror does not notice a line height or font size that changes alone:
// its height map keeps the old heights, so clicks and the cursor land on the
// wrong lines. It re-measures everything after a "refresh" (@codemirror/view
// 6's `viewState.mustMeasureContent`, what it sets itself once fonts load);
// recheck the name when upgrading @codemirror/view.
function refreshEditors() {
	for (const win of appWindows()) {
		for (const el of Array.from(win.document.querySelectorAll<HTMLElement>(".cm-editor"))) {
			const view = EditorView.findFromDOM(el);
			const viewState = (view as unknown as { viewState?: { mustMeasureContent: boolean | string } } | null)?.viewState;
			if (!view || !viewState) continue;
			refreshLivePreview(view);
			viewState.mustMeasureContent = "refresh";
			view.requestMeasure();
		}
	}
}
