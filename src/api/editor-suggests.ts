import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import type { App } from "./app";
import { Editor, type EditorPosition } from "./editor";
import { parseFrontMatterAliases } from "./metadata-utils";
import { EditorSuggest, type EditorSuggestTriggerInfo } from "./ui/suggest";
import { prepareFuzzySearch, renderMatches, type SearchResult } from "./util";
import type { TFile } from "./vault";

// Obsidian's built-in editor suggests: links after `[[` and `![[`, tags
// after `#`. They are registered before plugins load, so they come first in
// workspace.editorSuggest.suggests and a plugin suggest that matches
// everywhere (Completr) still gets the other positions.

function insideNode(editor: Editor, pos: EditorPosition, names: Set<string>) {
	const state = editor.cm.state;
	for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(editor.posToOffset(pos), -1); n; n = n.parent) {
		if (names.has(n.name)) return true;
	}
	return false;
}

const CODE = new Set(["InlineCode", "FencedCode", "CodeBlock", "InlineMath", "BlockMath", "comment", "comment-block"]);
const NO_TAGS = new Set([...CODE, "hmd-frontmatter", "internal-link", "internal-embed", "Link", "URL"]);

interface LinkSuggestion {
	file: TFile;
	display: string;
	note: string;
	match: SearchResult | null;
	heading?: string;
	level?: number;
	alias?: string;
}

export class LinkSuggest extends EditorSuggest<LinkSuggestion> {
	#embed = false;

	constructor(app: App) {
		super(app);
		this.setInstructions([
			{ command: "Type #", purpose: "to link heading" },
			{ command: "Type |", purpose: "to change display text" },
		]);
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		if (!(editor instanceof Editor)) return null;
		const m = /(!?)\[\[([^[\]]*)$/.exec(editor.getLine(cursor.line).slice(0, cursor.ch));
		if (!m || m[2].includes("|") || insideNode(editor, cursor, CODE)) return null;
		this.#embed = !!m[1];
		return { start: { line: cursor.line, ch: m.index }, end: cursor, query: m[2] };
	}

	getSuggestions(context: { query: string; file: TFile | null }): LinkSuggestion[] {
		const { query } = context;
		const hash = query.indexOf("#");
		if (hash >= 0) return this.#headings(query.slice(0, hash), query.slice(hash + 1), context.file);
		const files = this.app.vault.getFiles();
		const text = (f: TFile) => (f.extension === "md" ? f.path.slice(0, -3) : f.path);
		const note = (f: TFile) => (f.parent && !f.parent.isRoot() ? f.parent.path : "");
		if (!query.trim()) {
			const recent = this.app.workspace.getLastOpenFiles();
			const rank = (f: TFile) => {
				const i = recent.indexOf(f.path);
				return i < 0 ? recent.length : i;
			};
			return files
				.sort((a, b) => rank(a) - rank(b) || b.stat.mtime - a.stat.mtime)
				.slice(0, this.limit)
				.map((file) => ({ file, display: file.extension === "md" ? file.basename : file.name, note: note(file), match: null }));
		}
		const search = prepareFuzzySearch(query.trim());
		const results: LinkSuggestion[] = [];
		for (const file of files) {
			const display = text(file);
			const match = search(display);
			if (match) results.push({ file, display, note: "", match });
			const aliases = file.extension === "md" ? parseFrontMatterAliases(this.app.metadataCache.getFileCache(file)?.frontmatter) : null;
			for (const alias of aliases ?? []) {
				const m = search(alias);
				if (m) results.push({ file, display: alias, note: display, match: m, alias });
			}
		}
		return results.sort((a, b) => b.match!.score - a.match!.score);
	}

	#headings(linkpath: string, query: string, source: TFile | null): LinkSuggestion[] {
		const file = linkpath ? this.app.metadataCache.getFirstLinkpathDest(linkpath, source?.path ?? "") : source;
		if (!file) return [];
		const search = prepareFuzzySearch(query.trim());
		const results: LinkSuggestion[] = [];
		for (const h of this.app.metadataCache.getFileCache(file)?.headings ?? []) {
			const match = query.trim() ? search(h.heading) : { score: 0, matches: [] };
			if (match) results.push({ file, display: h.heading, note: file.basename, match, heading: h.heading, level: h.level });
		}
		return query.trim() ? results.sort((a, b) => b.match!.score - a.match!.score) : results;
	}

	renderSuggestion(value: LinkSuggestion, el: HTMLElement) {
		el.addClass("mod-complex");
		const content = el.createDiv("suggestion-content");
		renderMatches(content.createDiv("suggestion-title"), value.display, value.match?.matches ?? null);
		if (value.note) content.createDiv({ cls: "suggestion-note", text: value.note });
		const aux = el.createDiv("suggestion-aux");
		if (value.level) aux.createSpan({ cls: "suggestion-flair", text: `H${value.level}` });
		else if (value.alias) aux.createSpan({ cls: "suggestion-flair", text: "alias" });
		else if (value.file.extension !== "md") aux.createSpan({ cls: "suggestion-flair", text: value.file.extension });
	}

	selectSuggestion(value: LinkSuggestion) {
		const context = this.context;
		if (!context) return;
		// Closed first, so moving the cursor does not trigger it again.
		this.close();
		const editor: Editor = context.editor;
		const sourcePath = context.file?.path ?? "";
		// The rest of a link being retargeted, through its closing brackets
		// (auto-paired or already there); display text it has stays.
		const rest = editor.getLine(context.end.line).slice(context.end.ch);
		const tail = /^[^[\]|\n]*(?:\|([^[\]\n]*))?\]\]/.exec(rest);
		const alias = tail?.[1] || value.alias;
		const sameNote = value.heading !== undefined && context.query.startsWith("#");
		let link = sameNote
			? `[[#${value.heading}${alias ? `|${alias}` : ""}]]`
			: this.app.fileManager.generateMarkdownLink(value.file, sourcePath, value.heading !== undefined ? `#${value.heading}` : "", alias);
		if (this.#embed) link = `!${link}`;
		editor.replaceRange(link, context.start, { line: context.end.line, ch: context.end.ch + (tail?.[0].length ?? 0) });
		editor.setCursor({ line: context.start.line, ch: context.start.ch + link.length });
	}
}

interface TagSuggestion {
	tag: string;
	count: number;
	match: SearchResult | null;
}

const TAG_QUERY = /(^|\s)#([^\s#!@$%^&*(),.?":{}|<>[\]\\`'~;=+]*)$/;

export class TagSuggest extends EditorSuggest<TagSuggestion> {
	// Set by the insert-tag command so a bare `#` opens the list.
	force = false;

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		const force = this.force;
		this.force = false;
		if (!(editor instanceof Editor)) return null;
		const m = TAG_QUERY.exec(editor.getLine(cursor.line).slice(0, cursor.ch));
		if (!m || /^\d+$/.test(m[2])) return null;
		// A bare `#` at the start of a line is usually a heading being typed.
		if (!m[2] && !force && !m[1]) return null;
		if (insideNode(editor, cursor, NO_TAGS)) return null;
		const ch = cursor.ch - m[2].length - 1;
		return { start: { line: cursor.line, ch }, end: cursor, query: m[2] };
	}

	getSuggestions(context: { query: string }): TagSuggestion[] {
		const tags = Object.entries(this.app.metadataCache.getTags());
		const query = context.query.trim();
		if (!query) return tags.sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count, match: null }));
		const search = prepareFuzzySearch(query);
		const results: TagSuggestion[] = [];
		for (const [tag, count] of tags) {
			const match = search(tag.slice(1));
			if (match) results.push({ tag, count, match: { score: match.score, matches: match.matches.map(([s, e]) => [s + 1, e + 1] as [number, number]) } });
		}
		return results.sort((a, b) => b.match!.score - a.match!.score || b.count - a.count);
	}

	renderSuggestion(value: TagSuggestion, el: HTMLElement) {
		el.addClass("mod-complex");
		renderMatches(el.createDiv("suggestion-content").createDiv("suggestion-title"), value.tag, value.match?.matches ?? null);
		el.createDiv("suggestion-aux").createSpan({ cls: "suggestion-flair", text: String(value.count) });
	}

	selectSuggestion(value: TagSuggestion) {
		const context = this.context;
		if (!context) return;
		// Closed first: moving the cursor while open would trigger it again
		// on the tag just inserted.
		this.close();
		const editor: Editor = context.editor;
		// Replace the whole tag under the cursor, including its tail.
		const rest = editor.getLine(context.end.line).slice(context.end.ch);
		const tail = /^[^\s#!@$%^&*(),.?":{}|<>[\]\\`'~;=+]*/.exec(rest)?.[0].length ?? 0;
		editor.replaceRange(value.tag, context.start, { line: context.end.line, ch: context.end.ch + tail });
		editor.setCursor({ line: context.start.line, ch: context.start.ch + value.tag.length });
	}
}

export function registerEditorSuggests(app: App) {
	app.workspace.editorSuggest.addSuggest(new LinkSuggest(app));
	app.workspace.editorSuggest.addSuggest(new TagSuggest(app));
}
