import * as nodePath from "node:path";
import * as YAML from "yaml";
import type { App } from "./app";
import { insertProperty, locateFrontmatter, readProperties, removeProperty, replaceFrontmatter, setProperty } from "./frontmatter-edit";
import { htmlMediaSrcs, rewrittenSrc, srcVaultPath } from "./html-links";
import { encodePath, encodeSubpath } from "./link-encoding";
import { parseMetadata, type Reference, type ReferenceCache } from "./metadata";
import { texRelink, textParserFor } from "./metadata-text";
import { getLinkpath, locateFrontMatter, parseLinktext } from "./metadata-utils";
import { Modal } from "./ui/modal";
import { normalizePath } from "./util";
import { type DataWriteOptions, type TAbstractFile, TFile, TFolder, Vault } from "./vault";

// Takes the ref written as `original` nearest to `offset` out of `refs`.
function claim(refs: ReferenceCache[], original: string, offset: number) {
	let best = -1;
	const distance = (i: number) => Math.abs(refs[i].position.start.offset - offset);
	for (let i = 0; i < refs.length; i++) {
		if (refs[i].original === original && (best < 0 || distance(i) < distance(best))) best = i;
	}
	return best < 0 ? null : refs.splice(best, 1)[0];
}

// The note with its frontmatter turned from `before` into `after` one
// property at a time; null when the YAML cannot be edited line by line.
function editProperties(text: string, before: Record<string, unknown>, after: Record<string, unknown>) {
	const at = locateFrontmatter(text);
	let yaml = at ? text.slice(at.yamlFrom, at.yamlTo) : "";
	if (!readProperties(yaml)) return null;
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	for (const key of Object.keys(before)) if (after[key] === undefined) yaml = removeProperty(yaml, key);
	for (const [key, value] of Object.entries(after)) {
		if (value === undefined || (key in before && same(before[key], value))) continue;
		yaml = key in before ? setProperty(yaml, key, value) : insertProperty(yaml, key, value);
	}
	return replaceFrontmatter(text, yaml);
}

// Markdown the metadata cache does not index, held inside other files (the
// Canvas core plugin's text cards). renameFile reads each holder's texts
// before a rename and rewrites the links in them that no longer reach their
// file, as it does in notes. justnotes' own.
export interface LinkHolder {
	// Each held text: the file holding it (its links resolve from that file's
	// path), a key the holder finds it by again, and the Markdown.
	texts(): Promise<{ file: TFile; key: string; text: string }[]>;
	// Rewrites the held texts of `file`: `edit` gets each key and text and
	// returns the new text.
	edit(file: TFile, edit: (key: string, text: string) => string): Promise<void>;
}

interface HeldLink {
	holder: LinkHolder;
	source: TFile;
	key: string;
	ref: ReferenceCache;
	target: TFile;
}

export class FileManager {
	app: App;
	linkHolders = new Set<LinkHolder>();

	constructor(app: App) {
		this.app = app;
	}

	// newFileLocation: 'root' (default), 'current' (the folder of sourcePath; an
	// empty sourcePath means no active file) or 'folder' (newFileFolderPath).
	// A non-Markdown newFilePath goes to the attachment folder when it exists.
	getNewFileParent(sourcePath: string, newFilePath?: string): TFolder {
		const vault = this.app.vault;
		const root = vault.getRoot();
		if (newFilePath && !/\.md$/i.test(newFilePath)) return this.#folder(this.#attachmentDir(sourcePath)) ?? root;
		const location = vault.getConfig("newFileLocation");
		if (location === "current") return vault.getAbstractFileByPath(sourcePath || "/")?.parent ?? root;
		if (location === "folder") return this.#folder(vault.getConfig("newFileFolderPath") || "/") ?? root;
		return root;
	}

	// A configured folder may differ in case from the one on a case-insensitive disk.
	#find(path: string) {
		const vault = this.app.vault;
		return vault.adapter.insensitive ? vault.getAbstractFileByPathInsensitive(path) : vault.getAbstractFileByPath(path);
	}

	#folder(path: string) {
		const found = this.#find(path);
		return found instanceof TFolder ? found : null;
	}

	async createNewMarkdownFile(folder: TFolder, name = "Untitled", content = "") {
		return this.createNewNoteFile(folder, "md", name, content);
	}

	// justnotes' own: a new note of any note extension (md, tex, txt), named
	// "Untitled" and numbered past the names the folder already has.
	async createNewNoteFile(folder: TFolder, extension: string, name = "Untitled", content = "") {
		const base = folder.isRoot() ? "" : `${folder.path}/`;
		return this.app.vault.create(this.app.vault.getAvailablePath(`${base}${name}`, extension), content);
	}

	async createNewMarkdownFileFromLinktext(linktext: string, sourcePath: string) {
		const parent = this.getNewFileParent(sourcePath);
		const dir = nodePath.posix.dirname(linktext);
		const folderPath = dir === "." ? parent.path : normalizePath(`${parent.isRoot() ? "" : parent.path}/${dir}`);
		const folder = this.#folder(folderPath) ?? (await this.app.vault.createFolder(folderPath));
		// A Markdown link names the note with its extension ([x](New.md)).
		return this.createNewMarkdownFile(folder, nodePath.posix.basename(linktext).replace(/\.md$/i, ""));
	}

	// Moves the file or folder, then rewrites every link that no longer
	// reaches its target: links to the moved files, and the moved notes' own
	// links that depended on their old folder. Each link keeps its style,
	// subpath and alias. Relative srcs of raw HTML media (`<img src>`, see
	// html-links.ts) that named a moved file, or that a moved note holds, are
	// rewritten relative to the note the same way. With alwaysUpdateLinks
	// off the user is asked first.
	// The links come from the metadata cache, so it must have read every
	// earlier write first, such as the notes a previous rename rewrote.
	async renameFile(file: TAbstractFile, newPath: string) {
		const vault = this.app.vault;
		const cache = this.app.metadataCache;
		newPath = normalizePath(newPath);
		if (newPath === file.path) return;
		await this.#cacheClean();
		const moved: TFile[] = [];
		if (file instanceof TFolder) Vault.recurseChildren(file, (f) => f instanceof TFile && moved.push(f));
		else if (file instanceof TFile) moved.push(file);

		// `was` is the target's path before the move: a TeX path is rewritten
		// relative to the folder its old form was relative to.
		const candidates: { source: TFile; ref: Reference; target: TFile; was: string; from: string }[] = [];
		for (const target of moved) {
			for (const [path, refs] of cache.getBacklinksForFile(target).data) {
				const source = vault.getFileByPath(path);
				if (source) for (const ref of refs) candidates.push({ source, ref, target, was: target.path, from: source.path });
			}
		}
		for (const source of moved) {
			const own = cache.getFileCache(source);
			for (const ref of [...(own?.links ?? []), ...(own?.embeds ?? []), ...(own?.frontmatterLinks ?? [])]) {
				const target = cache.getFirstLinkpathDest(getLinkpath(ref.link), source.path);
				if (target) candidates.push({ source, ref, target, was: target.path, from: source.path });
			}
		}
		const held = await this.#heldLinks(moved);

		const htmlCandidates = await this.#htmlSrcCandidates(moved);

		await vault.rename(file, newPath);

		const edits = new Map<TFile, Map<Reference, Relink>>();
		let count = 0;
		for (const { source, ref, target, was, from } of candidates) {
			// A TeX path must still be right as TeX reads it, which the lenient
			// link resolution cannot tell: it changes when its rewrite does.
			if (ref.original.startsWith("\\")) {
				if (texRelink(ref, { from, to: source.path }, target.path, was) === ref.original) continue;
			} else if (cache.getFirstLinkpathDest(getLinkpath(ref.link), source.path) === target) continue;
			let refs = edits.get(source);
			if (!refs) edits.set(source, (refs = new Map()));
			if (!refs.has(ref)) count++;
			refs.set(ref, { target, was, from });
		}
		const heldEdits = new Map<LinkHolder, Map<TFile, Map<string, Map<Reference, TFile>>>>();
		const heldFiles = new Set<TFile>();
		for (const { holder, source, key, ref, target } of held) {
			if (cache.getFirstLinkpathDest(getLinkpath(ref.link), source.path) === target) continue;
			let files = heldEdits.get(holder);
			if (!files) heldEdits.set(holder, (files = new Map()));
			let keys = files.get(source);
			if (!keys) files.set(source, (keys = new Map()));
			let refs = keys.get(key);
			if (!refs) keys.set(key, (refs = new Map()));
			refs.set(ref, target);
			heldFiles.add(source);
			count++;
		}
		const htmlEdits = new Map<TFile, Map<string, TFile>>();
		for (const { source, value, target } of htmlCandidates) {
			if (this.#srcFile(value, source.path) === target) continue;
			let srcs = htmlEdits.get(source);
			if (!srcs) htmlEdits.set(source, (srcs = new Map()));
			if (!srcs.has(value)) count++;
			srcs.set(value, target);
		}
		const files = new Set([...edits.keys(), ...heldFiles, ...htmlEdits.keys()]).size;
		if (files && (vault.getConfig("alwaysUpdateLinks") || (await this.#confirmUpdate(files, count)))) {
			for (const [source, refs] of edits) await this.#rewrite(source, refs);
			for (const [holder, byFile] of heldEdits) {
				for (const [source, keys] of byFile) {
					await holder.edit(source, (key, text) => {
						const refs = keys.get(key);
						return refs ? this.#relinkText(text, new Map([...refs].map(([ref, target]) => [ref, { target, was: target.path, from: source.path }])), source.path) : text;
					});
				}
			}
			for (const [source, srcs] of htmlEdits) await this.#rewriteHtmlSrcs(source, srcs);
		}
		await this.#cacheClean();
	}

	// The links in the holders' texts that reach a moved file, or that a moved
	// file holds, as they resolve before the rename.
	async #heldLinks(moved: TFile[]) {
		const cache = this.app.metadataCache;
		const movedSet = new Set(moved);
		const out: HeldLink[] = [];
		for (const holder of this.linkHolders) {
			for (const { file: source, key, text } of await holder.texts()) {
				const own = parseMetadata(text);
				for (const ref of [...(own.links ?? []), ...(own.embeds ?? [])]) {
					const target = cache.getFirstLinkpathDest(getLinkpath(ref.link), source.path);
					if (target && (movedSet.has(target) || movedSet.has(source))) out.push({ holder, source, key, ref, target });
				}
			}
		}
		return out;
	}

	// The vault file a raw HTML src names exactly, relative to its note (not
	// by name alone, as the views also find one).
	#srcFile(src: string, sourcePath: string) {
		const path = srcVaultPath(src, sourcePath);
		const found = path ? this.#find(path) : null;
		return found instanceof TFile ? found : null;
	}

	// Before a move: the HTML srcs that name a moved file, and those in moved
	// notes. Only notes that hold a moved file's name are read.
	async #htmlSrcCandidates(moved: TFile[]) {
		const out: { source: TFile; value: string; target: TFile }[] = [];
		const movedSet = new Set(moved);
		const names = moved.filter((f) => f.extension !== "md").flatMap((f) => [f.name, encodeURI(f.name)]);
		for (const note of this.app.vault.getMarkdownFiles()) {
			const own = movedSet.has(note);
			if (!own && !names.length) continue;
			const text = await this.app.vault.cachedRead(note);
			if (!own && !names.some((name) => text.includes(name))) continue;
			for (const { value } of htmlMediaSrcs(text)) {
				const target = this.#srcFile(value, note.path);
				if (target && (own || movedSet.has(target))) out.push({ source: note, value, target });
			}
		}
		return out;
	}

	async #rewriteHtmlSrcs(source: TFile, srcs: Map<string, TFile>) {
		await this.app.vault.process(source, (text) => {
			let out = text;
			for (const { from, to, value } of htmlMediaSrcs(text).reverse()) {
				const target = srcs.get(value);
				if (target) out = out.slice(0, from) + rewrittenSrc(value, source.path, target.path) + out.slice(to);
			}
			return out;
		});
	}

	// Points every link to `file` at `target` instead, each keeping its style,
	// subpath and alias (Note composer's merge, before `file` goes). With
	// `subpaths`, only the links whose subpath it maps go, given the mapped
	// subpath (Note composer's extracted heading).
	async redirectLinks(file: TFile, target: TFile, subpaths?: Map<string, string>) {
		await this.#cacheClean();
		for (const [path, refs] of this.app.metadataCache.getBacklinksForFile(file).data) {
			const source = this.app.vault.getFileByPath(path);
			if (!source) continue;
			const moved = new Map<Reference, Relink>();
			const given = new Map<Reference, string>();
			for (const ref of refs) {
				const subpath = parseLinktext(ref.link).subpath;
				if (subpaths && !subpaths.has(subpath)) continue;
				moved.set(ref, { target, was: file.path, from: source.path });
				if (subpaths) given.set(ref, subpaths.get(subpath)!);
			}
			if (moved.size) await this.#rewrite(source, moved, given);
		}
		await this.#cacheClean();
	}

	// Before its first index the cache has nothing to catch up with.
	#cacheClean() {
		const cache = this.app.metadataCache;
		return cache.resolved ? new Promise<void>((resolve) => cache.onCleanCache(resolve)) : Promise.resolve();
	}

	#confirmUpdate(files: number, links: number) {
		const notes = files === 1 ? "1 file" : `${files} files`;
		return this.#confirm("Update links", `Update ${links === 1 ? "1 link" : `${links} links`} in ${notes} to the new location?`, "Update");
	}

	// Splices each new link over the old one, last first so offsets hold.
	// Each link is looked up again in the current text, among the links
	// written the same way, nearest its cached place: the note may have been
	// edited since it was indexed.
	async #rewrite(source: TFile, refs: Map<Reference, Relink>, subpaths?: Map<Reference, string>) {
		await this.app.vault.process(source, (text) => this.#relinkText(text, refs, source.path, subpaths, source.extension));
	}

	// `text` (a note, a TeX or text file, or Markdown held in `sourcePath`)
	// with each ref pointed at its target, keeping its subpath unless
	// `subpaths` gives another.
	#relinkText(text: string, refs: Map<Reference, Relink>, sourcePath: string, subpaths?: Map<Reference, string>, extension = "md") {
		const fm = locateFrontMatter(text);
		const current = (textParserFor(extension) ?? parseMetadata)(text);
		const unclaimed = [...(current.links ?? []), ...(current.embeds ?? [])];
		const splices = new Map<number, { to: number; text: string }>();
		for (const [ref, relink] of refs) {
			const replacement = this.#relink(ref, sourcePath, relink, subpaths?.get(ref));
			const position = (ref as ReferenceCache).position;
			if (position) {
				const found = claim(unclaimed, ref.original, position.start.offset);
				if (found) splices.set(found.position.start.offset, { to: found.position.end.offset, text: replacement });
			} else if (fm) {
				for (let at = text.indexOf(ref.original, fm.from); at >= 0 && at < fm.to; at = text.indexOf(ref.original, at + 1)) {
					splices.set(at, { to: at + ref.original.length, text: replacement });
				}
			}
		}
		let out = text;
		for (const [from, { to, text: replacement }] of [...splices].sort((a, b) => b[0] - a[0])) out = out.slice(0, from) + replacement + out.slice(to);
		return out;
	}

	#relink(ref: Reference, sourcePath: string, { target, was, from }: Relink, newSubpath?: string) {
		const cache = this.app.metadataCache;
		// A TeX source's \input-like command (metadata-text.ts).
		if (ref.original.startsWith("\\")) return texRelink(ref, { from, to: sourcePath }, target.path, was);
		const { path, subpath: oldSubpath } = parseLinktext(ref.link);
		const subpath = newSubpath ?? oldSubpath;
		const keepMd = /\.md$/i.test(path);
		const original = ref.original;
		const embed = original.startsWith("!") ? "!" : "";
		if (original.startsWith(`${embed}[[`)) {
			const inner = original.slice(embed.length + 2, -2);
			const pipe = inner.search(/\\?\|/);
			const alias = pipe >= 0 ? inner.slice(pipe) : "";
			return `${embed}[[${cache.fileToLinktext(target, sourcePath, !keepMd)}${subpath}${alias}]]`;
		}
		const m = /^(!?\[(?:[^[\]]|\[[^[\]]*\])*\]\(\s*)(<[^<>]*>|(?:[^\s()]|\([^\s()]*\))*)([\s\S]*)$/.exec(original);
		if (!m) return original;
		const linkpath = cache.fileToLinktext(target, sourcePath, !keepMd && target.extension === "md");
		const dest = m[2].startsWith("<") ? `<${linkpath}${subpath}>` : encodePath(linkpath) + encodeSubpath(subpath);
		return m[1] + dest + m[3];
	}

	#confirm(title: string, message: string, action: string, warning = false) {
		return new Promise<boolean>((resolve) => {
			const modal = new Modal(this.app);
			let answer = false;
			modal.setTitle(title);
			modal.contentEl.createEl("p", { text: message });
			const buttons = modal.contentEl.createDiv("modal-button-container");
			const confirm = buttons.createEl("button", { text: action, cls: warning ? "mod-warning" : "mod-cta" });
			confirm.addEventListener("click", () => {
				answer = true;
				modal.close();
			});
			buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => modal.close());
			modal.onClose = () => resolve(answer);
			modal.open();
		});
	}

	// promptDelete (on by default) asks first; trashOption decides where it goes.
	async promptForDeletion(file: TAbstractFile) {
		if (this.app.vault.getConfig("promptDelete") !== false) {
			const ok = await this.#confirm("Delete", `Are you sure you want to delete "${file.name}"?`, "Delete", true);
			if (!ok) return false;
		}
		await this.trashFile(file);
		return true;
	}

	// trashOption: 'system' (default) uses the OS trash, falling back to the
	// vault's .trash; 'local' uses .trash; 'none' deletes permanently.
	async trashFile(file: TAbstractFile) {
		const option = this.app.vault.getConfig("trashOption");
		if (option === "none") await this.app.vault.delete(file, true);
		else await this.app.vault.trash(file, option !== "local");
	}

	// The link text follows useMarkdownLinks and newLinkFormat; a non-Markdown
	// file is linked as an embed. An empty alias means the file name.
	generateMarkdownLink(file: TFile, sourcePath: string, subpath = "", alias?: string) {
		const cache = this.app.metadataCache;
		const md = file.extension === "md";
		const embed = md ? "" : "!";
		if (this.app.vault.getConfig("useMarkdownLinks")) {
			const text = alias || (md ? file.basename : "");
			return `${embed}[${text}](${encodePath(cache.fileToLinktext(file, sourcePath, false))}${encodeSubpath(subpath)})`;
		}
		return `${embed}[[${cache.fileToLinktext(file, sourcePath, true)}${subpath}${alias ? `|${alias}` : ""}]]`;
	}

	// fn mutates the parsed frontmatter. Only the properties fn changed are
	// rewritten (frontmatter-edit.ts): the others keep their bytes, so a
	// comment or `zip: 02134` survives a plugin setting another property. New
	// ones go at the end, nothing is written when fn changes nothing, an
	// emptied block is removed, and the note keeps its line endings. Invalid
	// YAML, or YAML that is no map, throws before anything is written.
	async processFrontMatter(file: TFile, fn: (frontmatter: any) => void, options?: DataWriteOptions) {
		if (!(file instanceof TFile) || file.extension !== "md") throw new Error(`${file?.path ?? "File"} is not a Markdown file`);
		await this.app.vault.process(
			file,
			(text) => {
				const fm = locateFrontMatter(text);
				const parsed = fm ? YAML.parse(text.slice(fm.from, fm.to)) : null;
				// A block that holds text or a list, not properties (a note opening
				// with a paragraph between two rules), would be replaced.
				if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error(`${file.path}'s frontmatter is not a map of properties`);
				const data = parsed ?? {};
				const before = JSON.stringify(data);
				fn(data);
				if (JSON.stringify(data) === before) return text;
				const edited = editProperties(text, JSON.parse(before), data);
				if (edited !== null) return edited;
				const eol = text.includes("\r\n") ? "\r\n" : "\n";
				const body = fm ? text.slice(fm.end) : `${eol}${text}`;
				if (!Object.keys(data).length) return body.replace(/^\r?\n/, "");
				const yaml = YAML.stringify(data, { lineWidth: 0, nullStr: "" }).replace(/\n/g, eol);
				return `---${eol}${yaml}---${body}`;
			},
			options,
		);
	}

	// attachmentFolderPath: '/' is the vault root, './' the note's folder,
	// './sub' a folder next to the note, anything else a fixed folder, which is
	// created when missing. The name is deduplicated as 'name 1.ext', ...
	async getAvailablePathForAttachment(filename: string, sourcePath?: string) {
		const vault = this.app.vault;
		const dir = this.#attachmentDir(sourcePath ?? this.app.workspace.getActiveFile()?.path ?? "");
		if (dir !== "/" && !this.#find(dir)) await vault.createFolder(dir);
		const ext = nodePath.posix.extname(filename);
		const stem = filename.slice(0, filename.length - ext.length);
		return vault.getAvailablePath(dir === "/" ? stem : `${dir}/${stem}`, ext.slice(1));
	}

	#attachmentDir(sourcePath: string) {
		const configured: string = this.app.vault.getConfig("attachmentFolderPath") || "/";
		if (configured === "." || configured.startsWith("./")) {
			const dir = nodePath.posix.join(nodePath.posix.dirname(sourcePath || "x"), configured.slice(2));
			return dir === "." ? "/" : normalizePath(dir);
		}
		return normalizePath(configured);
	}
}

// A link's new target; `was` is the target's path and `from` the source's
// before the move.
interface Relink {
	target: TFile;
	was: string;
	from: string;
}
