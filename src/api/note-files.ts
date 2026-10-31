import { type TAbstractFile, TFile } from "./vault";

// The text files justnotes treats as notes: Markdown, and also TeX and plain
// text, which Obsidian leaves as attachments. They are indexed by the
// metadata cache, searched, counted, snapshotted, drawn in the graph and
// created from the New note menus. Markdown alone keeps Obsidian's API
// meaning wherever plugins look (getMarkdownFiles, MarkdownView, the
// frontmatter and tags of a CachedMetadata).
export const NOTE_EXTENSIONS: readonly string[] = ["md", "tex", "txt"];

export function isNoteExtension(extension: string) {
	return NOTE_EXTENSIONS.includes(extension);
}

export function isNoteFile(file: TAbstractFile | null | undefined): file is TFile {
	return file instanceof TFile && NOTE_EXTENSIONS.includes(file.extension);
}

// The name a file goes by in lists: a Markdown note without its extension,
// any other file (a TeX or text note too) with it.
export function fileDisplayName(file: TFile) {
	return file.extension === "md" ? file.basename : file.name;
}

// TeX and text files past this size (data dumps, logs, word vectors) open
// like any note but are not read for the metadata cache, search or the
// graph: a vault's .txt files can hold hundreds of megabytes of data.
export const TEXT_NOTE_INDEX_LIMIT = 2 * 1024 * 1024;

// A note whose text the app reads to index it: every Markdown note, and the
// other notes within TEXT_NOTE_INDEX_LIMIT.
export function isIndexedNote(file: TAbstractFile | null | undefined): file is TFile {
	return isNoteFile(file) && (file.extension === "md" || file.stat.size <= TEXT_NOTE_INDEX_LIMIT);
}
