import type { CorePluginHost } from "../api/internal-plugins";
import type { App } from "../api/app";
import { Editor } from "../api/editor";
import { MarkdownView } from "../api/markdown-view";
import { type HeadingCache, parseMetadata } from "../api/metadata";
import { locateFrontMatter, parseLinktext, resolveSubpath } from "../api/metadata-utils";
import type { Menu } from "../api/ui/menu";
import { Modal } from "../api/ui/modal";
import { Notice } from "../api/ui/notice";
import { FuzzySuggestModal } from "../api/ui/suggest";
import { moment, normalizePath } from "../api/util";
import { type TAbstractFile, TFile } from "../api/vault";
import { TextFileView } from "../api/view";
import { fillTemplate, templateEdits } from "./templates";

interface ComposerOptions {
	askBeforeMerging?: boolean;
	replacementText?: "link" | "embed" | "none";
	template?: string;
}

export interface ComposeVars {
	content: string;
	fromTitle: string;
	newTitle: string;
	date: moment.Moment;
}

// The text that lands in the destination: the content alone, or the
// template with {{content}}, {{fromTitle}}, {{newTitle}} and the Templates
// date variables filled in; a template without {{content}} gets the content
// at its bottom.
export function composeText(template: string | null, vars: ComposeVars) {
	if (template === null) return vars.content;
	const filled = fillTemplate(template.replace(/{{\s*fromTitle\s*}}/gi, () => vars.fromTitle).replace(/{{\s*newTitle\s*}}/gi, () => vars.newTitle), {
		title: vars.newTitle,
		date: vars.date,
		dateFormat: "YYYY-MM-DD",
		timeFormat: "HH:mm",
	});
	const parts = filled.split(/{{\s*content\s*}}/i);
	if (parts.length > 1) return parts.join(vars.content);
	return filled ? `${filled.replace(/\n*$/, "")}\n\n${vars.content}` : vars.content;
}

// A note with CRLF line breaks is worked on as LF and given CRLF back.
function keepEol(dest: string, edit: (lf: string) => string) {
	if (!dest.includes("\r\n")) return edit(dest);
	return edit(dest.replace(/\r\n/g, "\n")).replace(/\n/g, "\r\n");
}

// `dest` with `text` added at its end, or at its start just after its
// frontmatter, a blank line between them, with dest's line breaks.
export function addText(dest: string, text: string, at: "end" | "start") {
	return keepEol(dest, (lf) => addTextLf(lf, text.replace(/\r\n/g, "\n"), at));
}

function addTextLf(dest: string, text: string, at: "end" | "start") {
	const body = text.replace(/\n*$/, "");
	if (!dest.trim()) return `${body}\n`;
	if (at === "end") return `${dest.replace(/\n*$/, "")}\n\n${body}\n`;
	const end = locateFrontMatter(dest)?.end ?? 0;
	const head = end ? `${dest.slice(0, end)}\n` : "";
	const rest = dest.slice(end).replace(/^\n+/, "");
	return rest ? `${head}${body}\n\n${rest}` : `${head}${body}\n`;
}

// Merges `content` into `dest` (see addText); a frontmatter in `content`
// goes into dest's frontmatter, adding only the properties dest lacks, as an
// inserted template's does (throwing FrontmatterNotMapError when dest's is
// not a map of properties).
export function mergeText(dest: string, content: string, at: "end" | "start", compose: (body: string) => string = (body) => body) {
	return keepEol(dest, (lf) => mergeTextLf(lf, content.replace(/\r\n/g, "\n"), at, compose));
}

function mergeTextLf(dest: string, content: string, at: "end" | "start", compose: (body: string) => string) {
	const end = locateFrontMatter(content)?.end ?? 0;
	const fm = content.slice(0, end);
	const body = content.slice(end).replace(/^\n/, "");
	let out = addTextLf(dest, compose(body).replace(/\r\n/g, "\n"), at);
	if (fm) for (const e of [...templateEdits(out, 0, 0, `${fm}\n`)].reverse()) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
	return out;
}

export interface HeadingSection {
	heading: HeadingCache;
	// Offsets of the section: the heading line up to the next heading of the
	// same or a higher level, or the end.
	from: number;
	to: number;
	// The section's text without its heading line.
	body: string;
}

// The section of the heading the cursor's `line` is under.
export function headingSection(text: string, line: number): HeadingSection | null {
	const headings = parseMetadata(text).headings ?? [];
	let index = -1;
	for (let i = 0; i < headings.length && headings[i].position.start.line <= line; i++) index = i;
	if (index < 0) return null;
	const heading = headings[index];
	const next = headings.slice(index + 1).find((h) => h.level <= heading.level);
	const from = heading.position.start.offset;
	const to = next ? next.position.start.offset : text.length;
	const lineEnd = text.indexOf("\n", heading.position.end.offset);
	const body = lineEnd < 0 || lineEnd >= to ? "" : text.slice(lineEnd + 1, to);
	return { heading, from, to, body: body.replace(/^\n+/, "").replace(/\s+$/, "") };
}

// Where links into an extracted section go: each of `subpaths` (of links to
// the note `doc`) that resolves inside the section, mapped to its subpath in
// the destination. A note made from the section holds only its body, so a
// link to the section's heading loses its subpath and one to a heading
// under it names that heading alone; in another note the section keeps its
// heading, so subpaths stay as written. Block references stay as written.
export function movedSubpaths(doc: string, section: { from: number; to: number; heading: HeadingCache }, subpaths: Iterable<string>, created: boolean) {
	const cache = parseMetadata(doc);
	const moved = new Map<string, string>();
	for (const subpath of subpaths) {
		const found = subpath ? resolveSubpath(cache, subpath) : null;
		if (!found || found.start.offset < section.from || found.start.offset >= section.to) continue;
		if (!created || found.type !== "heading") moved.set(subpath, subpath);
		else moved.set(subpath, found.current.position.start.offset === section.heading.position.start.offset ? "" : `#${found.current.heading}`);
	}
	return moved;
}

// What replaces a section moved out of a note: the link (or nothing) on its
// own line, keeping the blank line before the next heading.
export function sectionReplacement(text: string, section: { from: number; to: number }, link: string) {
	if (!link) return "";
	if (section.to < text.length) return `${link}\n\n`;
	return text.slice(section.from, section.to).endsWith("\n") ? `${link}\n` : link;
}

// Characters a note name cannot hold, in a link or on disk.
const BAD_NAME = /[\\/:*?"<>|#^[\]]/g;

export function noteName(text: string) {
	return text.replace(BAD_NAME, " ").replace(/\s+/g, " ").trim();
}

function options(app: App): ComposerOptions {
	return app.internalPlugins.getPluginById("note-composer")?.instance.options ?? {};
}

async function templateText(app: App): Promise<string | null> {
	const path = options(app).template?.trim();
	if (!path) return null;
	const normal = normalizePath(path);
	const file = app.vault.getFileByPath(normal) ?? app.vault.getFileByPath(`${normal}.md`) ?? app.metadataCache.getFirstLinkpathDest(normal, "");
	if (!file) {
		new Notice(`The Note composer template "${path}" does not exist; the text goes in as it is.`);
		return null;
	}
	return app.vault.cachedRead(file);
}

// The link (or embed, or nothing) left where text was taken out, per
// note-composer.json's replacementText.
function replacementFor(app: App, file: TFile, sourcePath: string) {
	const mode = options(app).replacementText ?? "link";
	if (mode === "none") return "";
	const link = app.fileManager.generateMarkdownLink(file, sourcePath);
	return mode === "embed" && !link.startsWith("!") ? `!${link}` : link;
}

type Target = { file: TFile; at: "end" | "start" } | { create: string };

// Picks the note the text goes to: Enter adds it at the end of the chosen
// note, Shift+Enter at its start, Mod+Enter (or Enter with no match) creates
// a note named as typed, as in Obsidian.
class ComposerModal extends FuzzySuggestModal<TFile> {
	#exclude: TFile;
	#onChoose: (target: Target) => void;

	constructor(app: App, exclude: TFile, placeholder: string, initial: string, onChoose: (target: Target) => void) {
		super(app);
		this.#exclude = exclude;
		this.#onChoose = onChoose;
		this.setPlaceholder(placeholder);
		this.inputEl.value = initial;
		this.emptyStateText = "No notes found. Press Enter to create one.";
		this.setInstructions([
			{ command: "↵", purpose: "to add at the end" },
			{ command: "shift ↵", purpose: "to add at the start" },
			{ command: `${process.platform === "darwin" ? "cmd" : "ctrl"} ↵`, purpose: "to create a new note" },
			{ command: "esc", purpose: "to dismiss" },
		]);
		const create = () => {
			const name = noteName(this.inputEl.value);
			if (!name) return false;
			this.close();
			this.#onChoose({ create: name });
			return false;
		};
		this.scope.register(["Mod"], "Enter", create);
		this.scope.register(["Shift"], "Enter", (evt) => {
			this.chooser.useSelectedItem(evt);
			return false;
		});
		// Before the list's own Enter, which does nothing on an empty list.
		const enter = this.scope.register([], "Enter", () => (this.chooser.values.length ? undefined : create()));
		this.scope.keys.remove(enter);
		this.scope.keys.unshift(enter);
	}

	getItems() {
		return this.app.vault
			.getMarkdownFiles()
			.filter((f) => f !== this.#exclude)
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	getItemText(file: TFile) {
		return file.path.slice(0, -3);
	}

	onChooseItem(file: TFile, evt: MouseEvent | KeyboardEvent) {
		this.#onChoose({ file, at: evt.shiftKey ? "start" : "end" });
	}
}

function confirm(app: App, title: string, message: string, action: string) {
	let resolve: (answer: boolean) => void = () => {};
	const promise = new Promise<boolean>((r) => (resolve = r));
	const modal = new Modal(app);
	let answer = false;
	modal.setTitle(title);
	modal.contentEl.createEl("p", { text: message });
	const buttons = modal.contentEl.createDiv("modal-button-container");
	buttons.createEl("button", { text: action, cls: "mod-cta" }).addEventListener("click", () => {
		answer = true;
		modal.close();
	});
	buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
	modal.onClose = () => resolve(answer);
	modal.open();
	return promise;
}

// Writes `text` into the target, creating the note if asked. Returns it.
async function deliver(app: App, target: Target, source: TFile, content: string) {
	const template = await templateText(app);
	const newTitle = "create" in target ? target.create : target.file.basename;
	const compose = (body: string) => composeText(template, { content: body, fromTitle: source.basename, newTitle, date: moment() });
	if ("create" in target) {
		const folder = app.fileManager.getNewFileParent(source.path, `${target.create}.md`);
		return app.fileManager.createNewMarkdownFile(folder, target.create, mergeText("", content, "end", compose));
	}
	await app.vault.process(target.file, (dest) => mergeText(dest, content, target.at, compose));
	return target.file;
}

// Unsaved edits of the note reach the disk before it is read.
async function saveViews(app: App, file: TFile) {
	const views: TextFileView[] = [];
	app.workspace.iterateAllLeaves((leaf) => {
		if (leaf.view instanceof TextFileView && leaf.view.file === file) views.push(leaf.view);
	});
	for (const view of views) await view.save();
}

// Merges `source` into the chosen note, points links to it at that note and
// deletes it, opening the merged note where it was shown.
export function mergeFile(app: App, source: TFile) {
	new ComposerModal(app, source, "Merge into...", "", async (target) => {
		const into = "create" in target ? `a new note "${target.create}"` : `"${target.file.basename}"`;
		if (options(app).askBeforeMerging !== false) {
			const ok = await confirm(app, "Merge file", `Merge "${source.basename}" into ${into}? "${source.basename}" will be deleted.`, "Merge");
			if (!ok) return;
		}
		try {
			await saveViews(app, source);
			const dest = await deliver(app, target, source, await app.vault.read(source));
			await app.fileManager.redirectLinks(source, dest);
			const leaves: { openFile(file: TFile): Promise<void> }[] = [];
			app.workspace.iterateRootLeaves((leaf) => {
				if (leaf.view instanceof TextFileView && leaf.view.file === source) leaves.push(leaf);
			});
			for (const leaf of leaves) await leaf.openFile(dest);
			await app.fileManager.trashFile(source);
			new Notice(`Merged "${source.basename}" into "${dest.basename}".`);
		} catch (err) {
			console.error(err);
			new Notice(`Could not merge: ${err instanceof Error ? err.message : err}`);
		}
	}).open();
}

// Moves the editor's [from, to) to the chosen note, leaving the replacement;
// `moved` then runs with the destination and whether it was created.
function extract(
	app: App,
	editor: Editor,
	source: TFile,
	range: { from: number; to: number },
	take: (target: Target) => string,
	initial: string,
	replace: (link: string) => string,
	moved?: (dest: TFile, created: boolean) => Promise<void>,
) {
	const original = editor.getValue().slice(range.from, range.to);
	new ComposerModal(app, source, "Extract into...", initial, async (target) => {
		try {
			// The text may have moved while the modal was open; it must still
			// be where it was.
			if (editor.getValue().slice(range.from, range.to) !== original) {
				new Notice("The note changed; nothing was extracted.");
				return;
			}
			const dest = await deliver(app, target, source, take(target));
			if (editor.getValue().slice(range.from, range.to) !== original) {
				new Notice(`The note changed; the text was copied to "${dest.basename}" but left in place.`);
				return;
			}
			editor.replaceRange(replace(replacementFor(app, dest, source.path)), editor.offsetToPos(range.from), editor.offsetToPos(range.to), "note-composer");
			await moved?.(dest, "create" in target);
		} catch (err) {
			console.error(err);
			new Notice(`Could not extract: ${err instanceof Error ? err.message : err}`);
		}
	}).open();
}

function extractSelection(app: App, editor: Editor, source: TFile) {
	const cm = editor.cm;
	const { from, to } = cm.state.selection.main;
	const text = cm.state.sliceDoc(from, to);
	extract(app, editor, source, { from, to }, () => text, "", (link) => link);
}

// Links to the extracted heading, the headings under it and its blocks go to
// the new note, as in Obsidian: the subpaths are judged in the text before
// the extraction, the links rewritten once the note is saved without it.
async function redirectSection(app: App, source: TFile, doc: string, section: HeadingSection, dest: TFile, created: boolean) {
	const subpaths = new Set<string>();
	for (const refs of app.metadataCache.getBacklinksForFile(source).data.values()) for (const ref of refs) subpaths.add(parseLinktext(ref.link).subpath);
	const moved = movedSubpaths(doc, section, subpaths, created);
	if (!moved.size) return;
	await saveViews(app, source);
	await app.fileManager.redirectLinks(source, dest, moved);
}

function extractHeading(app: App, editor: Editor, source: TFile, section: HeadingSection) {
	const doc = editor.getValue();
	const whole = doc.slice(section.from, section.to).replace(/\s+$/, "");
	extract(
		app,
		editor,
		source,
		section,
		// A note named after the heading gets the body; added to another note,
		// the section keeps its heading.
		(target) => ("create" in target ? section.body : whole),
		noteName(section.heading.heading),
		(link) => sectionReplacement(doc, section, link),
		(dest, created) => redirectSection(app, source, doc, section, dest, created),
	);
}

// Obsidian's Note composer commands, with its ids, and its file and editor
// menu items.
export function installNoteComposer(app: App, host: CorePluginHost) {
	const editorCommand = (id: string, name: string, check: (editor: Editor, view: MarkdownView, run: boolean) => boolean) => {
		const cmd = {
			id,
			name,
			editorCheckCallback: (checking: boolean, editor: unknown, view: unknown) => {
				if (!(editor instanceof Editor) || !(view instanceof MarkdownView) || view.getMode() === "preview" || !view.file) return false;
				return check(editor, view, !checking);
			},
		};
		host.addEditorCommand(cmd);
	};
	host.addCommand({
		id: "note-composer:merge-file",
		name: "Note composer: Merge current file with another file...",
		checkCallback: (checking: boolean) => {
			const file = app.workspace.getActiveFile();
			if (file?.extension !== "md") return false;
			if (!checking) mergeFile(app, file);
			return true;
		},
	});
	editorCommand("note-composer:split-file", "Note composer: Extract current selection...", (editor, view, run) => {
		if (!editor.somethingSelected()) return false;
		if (run) extractSelection(app, editor, view.file!);
		return true;
	});
	editorCommand("note-composer:extract-heading", "Note composer: Extract this heading...", (editor, view, run) => {
		const section = headingSection(editor.getValue(), editor.getCursor().line);
		if (!section) return false;
		if (run) extractHeading(app, editor, view.file!, section);
		return true;
	});
	host.registerEvent(
		app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
			if (!(file instanceof TFile) || file.extension !== "md") return;
			menu.addItem((item) =>
				item
					.setTitle("Merge entire file with...")
					.setIcon("git-merge")
					.setSection("action")
					.onClick(() => mergeFile(app, file)),
			);
		}),
	);
	host.registerEvent(
		app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: unknown) => {
			if (!(view instanceof MarkdownView) || !view.file || !editor.somethingSelected()) return;
			menu.addItem((item) =>
				item
					.setTitle("Extract current selection...")
					.setIcon("scissors")
					.setSection("action")
					.onClick(() => extractSelection(app, editor, view.file!)),
			);
		}),
	);
}
