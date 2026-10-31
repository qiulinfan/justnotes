import * as nodePath from "node:path";
import * as YAML from "yaml";
import type { App } from "./app";
import { insertProperty, locateFrontmatter, readProperties, removeProperty, replaceFrontmatter, setProperty } from "./frontmatter-edit";
import { parseMetadata, type Reference, type ReferenceCache } from "./metadata";
import { getLinkpath, locateFrontMatter, parseLinktext } from "./metadata-utils";
import { Modal } from "./ui/modal";
import { normalizePath } from "./util";
import { type DataWriteOptions, type TAbstractFile, TFile, TFolder, Vault } from "./vault";

// Markdown link destinations: spaces and '#' in a path must be encoded; a
// block subpath keeps its '^' readable. Letters beyond ASCII stay as written
// (附件/图 1.png gives 附件/图%201.png), as in Obsidian's links and the
// owner's notes.
const encodeAscii = (text: string) => text.replace(/[\0-\x7f]+/g, (run) => encodeURI(run));
const encodePath = (path: string) => encodeAscii(path).replace(/#/g, "%23");
const encodeSubpath = (subpath: string) => encodeAscii(subpath).replace(/%5E/g, "^");

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
		const base = folder.isRoot() ? "" : `${folder.path}/`;
		return this.app.vault.create(this.app.vault.getAvailablePath(`${base}${name}`, "md"), content);
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
	// subpath and alias. With alwaysUpdateLinks off the user is asked first.
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

		const candidates: { source: TFile; ref: Reference; target: TFile }[] = [];
		for (const target of moved) {
			for (const [path, refs] of cache.getBacklinksForFile(target).data) {
				const source = vault.getFileByPath(path);
				if (source) for (const ref of refs) candidates.push({ source, ref, target });
			}
		}
		for (const source of moved) {
			const own = cache.getFileCache(source);
			for (const ref of [...(own?.links ?? []), ...(own?.embeds ?? []), ...(own?.frontmatterLinks ?? [])]) {
				const target = cache.getFirstLinkpathDest(getLinkpath(ref.link), source.path);
				if (target) candidates.push({ source, ref, target });
			}
		}
		const held = await this.#heldLinks(moved);

		await vault.rename(file, newPath);

		const edits = new Map<TFile, Map<Reference, TFile>>();
		let count = 0;
		for (const { source, ref, target } of candidates) {
			if (cache.getFirstLinkpathDest(getLinkpath(ref.link), source.path) === target) continue;
			let refs = edits.get(source);
			if (!refs) edits.set(source, (refs = new Map()));
			if (!refs.has(ref)) count++;
			refs.set(ref, target);
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
		const files = new Set([...edits.keys(), ...heldFiles]).size;
		if (files && (vault.getConfig("alwaysUpdateLinks") || (await this.#confirmUpdate(files, count)))) {
			for (const [source, refs] of edits) await this.#rewrite(source, refs);
			for (const [holder, byFile] of heldEdits) {
				for (const [source, keys] of byFile) {
					await holder.edit(source, (key, text) => {
						const refs = keys.get(key);
						return refs ? this.#relinkText(text, refs, source.path) : text;
					});
				}
			}
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

	// Points every link to `file` at `target` instead, each keeping its style,
	// subpath and alias (Note composer's merge, before `file` goes).
	async redirectLinks(file: TFile, target: TFile) {
		await this.#cacheClean();
		for (const [path, refs] of this.app.metadataCache.getBacklinksForFile(file).data) {
			const source = this.app.vault.getFileByPath(path);
			if (source) await this.#rewrite(source, new Map(refs.map((ref) => [ref, target])));
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
	async #rewrite(source: TFile, refs: Map<Reference, TFile>) {
		await this.app.vault.process(source, (text) => this.#relinkText(text, refs, source.path));
	}

	// `text` (a note, or Markdown held in `sourcePath`) with each ref pointed
	// at its target.
	#relinkText(text: string, refs: Map<Reference, TFile>, sourcePath: string) {
		const fm = locateFrontMatter(text);
		const current = parseMetadata(text);
		const unclaimed = [...(current.links ?? []), ...(current.embeds ?? [])];
		const splices = new Map<number, { to: number; text: string }>();
		for (const [ref, target] of refs) {
			const replacement = this.#relink(ref, target, sourcePath);
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

	#relink(ref: Reference, target: TFile, sourcePath: string) {
		const cache = this.app.metadataCache;
		const { path, subpath } = parseLinktext(ref.link);
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
