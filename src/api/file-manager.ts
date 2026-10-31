import * as nodePath from "node:path";
import * as YAML from "yaml";
import type { App } from "./app";
import type { Reference, ReferenceCache } from "./metadata";
import { getLinkpath, locateFrontMatter, parseLinktext } from "./metadata-utils";
import { Modal } from "./ui/modal";
import { normalizePath } from "./util";
import { type DataWriteOptions, type TAbstractFile, TFile, TFolder, Vault } from "./vault";

// Markdown link destinations: spaces and '#' in a path must be encoded; a
// block subpath keeps its '^' readable.
const encodePath = (path: string) => encodeURI(path).replace(/#/g, "%23");
const encodeSubpath = (subpath: string) => encodeURI(subpath).replace(/%5E/g, "^");

export class FileManager {
	app: App;

	constructor(app: App) {
		this.app = app;
	}

	// newFileLocation: 'root' (default), 'current' (the folder of sourcePath; an
	// empty sourcePath means no active file) or 'folder' (newFileFolderPath).
	// A non-Markdown newFilePath goes to the attachment folder when it exists.
	getNewFileParent(sourcePath: string, newFilePath?: string): TFolder {
		const vault = this.app.vault;
		const root = vault.getRoot();
		if (newFilePath && !/\.md$/i.test(newFilePath)) {
			const dir = this.#attachmentDir(sourcePath);
			return vault.getFolderByPath(dir) ?? root;
		}
		const location = vault.getConfig("newFileLocation");
		if (location === "current") return vault.getAbstractFileByPath(sourcePath || "/")?.parent ?? root;
		if (location === "folder") return vault.getFolderByPath(vault.getConfig("newFileFolderPath") || "/") ?? root;
		return root;
	}

	async createNewMarkdownFile(folder: TFolder, name = "Untitled", content = "") {
		const base = folder.isRoot() ? "" : `${folder.path}/`;
		return this.app.vault.create(this.app.vault.getAvailablePath(`${base}${name}`, "md"), content);
	}

	async createNewMarkdownFileFromLinktext(linktext: string, sourcePath: string) {
		const parent = this.getNewFileParent(sourcePath);
		const dir = nodePath.posix.dirname(linktext);
		const folderPath = dir === "." ? parent.path : normalizePath(`${parent.isRoot() ? "" : parent.path}/${dir}`);
		const folder = this.app.vault.getFolderByPath(folderPath) ?? (await this.app.vault.createFolder(folderPath));
		return this.createNewMarkdownFile(folder, nodePath.posix.basename(linktext));
	}

	// Moves the file or folder, then rewrites every link that no longer
	// reaches its target: links to the moved files, and the moved notes' own
	// links that depended on their old folder. Each link keeps its style,
	// subpath and alias. With alwaysUpdateLinks off the user is asked first.
	async renameFile(file: TAbstractFile, newPath: string) {
		const vault = this.app.vault;
		const cache = this.app.metadataCache;
		newPath = normalizePath(newPath);
		if (newPath === file.path) return;
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
		if (!edits.size) return;
		if (!vault.getConfig("alwaysUpdateLinks")) {
			const notes = edits.size === 1 ? "1 file" : `${edits.size} files`;
			const ok = await this.#confirm("Update links", `Update ${count === 1 ? "1 link" : `${count} links`} in ${notes} to the new location?`, "Update");
			if (!ok) return;
		}
		for (const [source, refs] of edits) await this.#rewrite(source, refs);
	}

	// Splices each new link over the old one, last first so offsets hold;
	// a link whose text changed since it was cached is left alone.
	async #rewrite(source: TFile, refs: Map<Reference, TFile>) {
		await this.app.vault.process(source, (text) => {
			const fm = locateFrontMatter(text);
			const splices = new Map<number, { to: number; text: string }>();
			for (const [ref, target] of refs) {
				const replacement = this.#relink(ref, target, source.path);
				const position = (ref as ReferenceCache).position;
				if (position) {
					const { start, end } = position;
					if (text.slice(start.offset, end.offset) === ref.original) splices.set(start.offset, { to: end.offset, text: replacement });
				} else if (fm) {
					for (let at = text.indexOf(ref.original, fm.from); at >= 0 && at < fm.to; at = text.indexOf(ref.original, at + 1)) {
						splices.set(at, { to: at + ref.original.length, text: replacement });
					}
				}
			}
			let out = text;
			for (const [from, { to, text: replacement }] of [...splices].sort((a, b) => b[0] - a[0])) out = out.slice(0, from) + replacement + out.slice(to);
			return out;
		});
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

	// fn mutates the parsed frontmatter. Key order is kept, nothing is written
	// when fn changes nothing, an emptied block is removed, and the note keeps
	// its line endings. Invalid YAML throws before anything is written.
	async processFrontMatter(file: TFile, fn: (frontmatter: any) => void, options?: DataWriteOptions) {
		if (!(file instanceof TFile) || file.extension !== "md") throw new Error(`${file?.path ?? "File"} is not a Markdown file`);
		await this.app.vault.process(
			file,
			(text) => {
				const fm = locateFrontMatter(text);
				const parsed = fm ? YAML.parse(text.slice(fm.from, fm.to)) : null;
				const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
				const before = JSON.stringify(data);
				fn(data);
				if (JSON.stringify(data) === before) return text;
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
		if (dir !== "/" && !vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
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
