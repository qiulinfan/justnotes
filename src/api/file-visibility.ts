// Which files the explorer, the quick switcher and link suggestions show
// ("Detect all file extensions", `showUnsupportedFiles`), and which ones the
// excluded files (`userIgnoreFilters`) push down or leave out.
import type { App } from "./app";
import { isCodeFile } from "./code-files";
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS } from "./markdown";
import type { TFile } from "./vault";

// Shown whatever "Detect all file extensions" says: Markdown, TeX and plain
// text (first-class in justnotes, unlike Obsidian), images, audio, video,
// PDFs, canvases and bases.
const ALWAYS_SHOWN = new Set(["md", "tex", "txt", "pdf", "canvas", "base", ...IMAGE_EXTENSIONS, ...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

// What justnotes opens itself, and what a plugin registered a view for.
export function isSupportedExtension(app: App, extension: string) {
	const ext = extension.toLowerCase();
	return ALWAYS_SHOWN.has(ext) || isCodeFile({ name: "", extension: ext }) || app.viewRegistry.isExtensionRegistered(ext);
}

export function isFileShown(app: App, file: TFile) {
	return app.vault.getConfig("showUnsupportedFiles") === true || isSupportedExtension(app, file.extension);
}

// Excluded files go after the others, keeping the order within each part.
export function excludedLast<T>(app: App, items: T[], pathOf: (item: T) => string): T[] {
	const kept: T[] = [];
	const excluded: T[] = [];
	for (const item of items) (app.metadataCache.isUserIgnored(pathOf(item)) ? excluded : kept).push(item);
	return excluded.length ? [...kept, ...excluded] : items;
}
