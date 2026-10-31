// Which files the explorer, the quick switcher and link suggestions show
// ("Detect all file extensions", `showUnsupportedFiles`), and which ones the
// excluded files (`userIgnoreFilters`) push down or leave out.
import type { App } from "./app";
import { IMAGE_EXTENSIONS } from "./markdown";
import type { TFile } from "./vault";

// What Obsidian opens itself: notes, canvases, bases, images, audio, video
// and PDFs (in justnotes, also what a plugin registered a view for).
export function isSupportedExtension(app: App, extension: string) {
	const ext = extension.toLowerCase();
	return app.viewRegistry.isExtensionRegistered(ext) || IMAGE_EXTENSIONS.has(ext) || ext === "pdf";
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
