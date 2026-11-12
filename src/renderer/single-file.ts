import * as nodePath from "node:path";
import type { App } from "../api/app";
import { htmlMediaSrcs, srcVaultPath } from "../api/html-links";
import { isIndexedNote } from "../api/note-files";
import type { TAbstractFile, TFile } from "../api/vault";

// A file opened in no vault gets a window of its own (main's openFileWindow,
// ?file=): its folder is the vault root, but the file table holds only the
// file, the files it links to or embeds (images, attachments, other notes,
// a TeX root's chapters) and what is written from the window (pasted
// images). Each note opened in the window lets in what it refers to, one
// level deep, whenever its links resolve again. Nothing outside the folder
// enters, nor hidden files.

// The layout of a file's window: the file, with the outline beside it and
// the file explorer in the collapsed left sidebar. The outline is open for a
// note; a book or a PDF has no headings to list (an EPUB shows its own
// contents), so there it starts collapsed.
export function singleFileLayout(name: string) {
	const note = /\.(md|markdown|tex)$/i.test(name);
	return {
		main: { type: "split", direction: "vertical", children: [{ type: "tabs", children: [{ type: "leaf", state: { type: "empty" } }] }] },
		left: { type: "split", direction: "horizontal", collapsed: true, children: [{ type: "tabs", children: [{ type: "leaf", state: { type: "file-explorer" } }] }] },
		right: { type: "split", direction: "horizontal", collapsed: !note, children: [{ type: "tabs", children: [{ type: "leaf", state: { type: "outline" } }] }] },
	};
}

// The vault paths a note refers to that are not in the file table: its
// unresolved links (relative to the note's folder; a name without an
// extension is also tried as a Markdown note) and its HTML media srcs.
export async function referencedPaths(app: App, file: TFile): Promise<string[]> {
	const out = new Set<string>();
	const dir = nodePath.posix.dirname(file.path);
	const add = (path: string | null) => {
		if (!path || path === "." || path.startsWith("../") || path.split("/").some((s) => s.startsWith("."))) return;
		if (!app.vault.getAbstractFileByPath(path)) out.add(path);
	};
	for (const link of Object.keys(app.metadataCache.unresolvedLinks[file.path] ?? {})) {
		const path = nodePath.posix.normalize(nodePath.posix.join(dir, link));
		add(path);
		if (!nodePath.posix.extname(path)) add(`${path}.md`);
	}
	if (file.extension === "md") {
		const text = await app.vault.cachedRead(file);
		for (const src of htmlMediaSrcs(text)) add(srcVaultPath(src.value, file.path));
	}
	return [...out];
}

export function installSingleFile(app: App, file: TFile) {
	const notes = new Set([file.path]);
	const letIn = async (note: TAbstractFile | null) => {
		if (!isIndexedNote(note) || !notes.has(note.path)) return;
		for (const path of await referencedPaths(app, note)) await app.vault.adapter.admit(path);
	};
	app.metadataCache.on("resolve", letIn);
	app.workspace.on("file-open", (opened) => {
		if (!opened) return;
		notes.add(opened.path);
		void letIn(opened);
	});
	app.vault.on("rename", (renamed, oldPath) => {
		if (notes.delete(oldPath)) notes.add(renamed.path);
	});
	return letIn(file);
}
