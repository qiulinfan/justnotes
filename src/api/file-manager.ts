import * as nodePath from "node:path";
import type { App } from "./app";
import { normalizePath, parseYaml, stringifyYaml } from "./util";
import type { TAbstractFile, TFile, TFolder } from "./vault";

export class FileManager {
	app: App;

	constructor(app: App) {
		this.app = app;
	}

	getNewFileParent(_sourcePath: string, _newFilePath?: string): TFolder {
		const location = this.app.vault.getConfig("newFileLocation");
		const folder = this.app.vault.getConfig("newFileFolderPath");
		if (location === "folder" && folder) return this.app.vault.getFolderByPath(folder) ?? this.app.vault.getRoot();
		if (location === "current") {
			const active = this.app.workspace.getActiveFile();
			if (active?.parent) return active.parent;
		}
		return this.app.vault.getRoot();
	}

	async createNewMarkdownFile(folder: TFolder, name = "Untitled", content = "") {
		const base = folder.isRoot() ? "" : `${folder.path}/`;
		let path = `${base}${name}.md`;
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = `${base}${name} ${i}.md`;
		return this.app.vault.create(path, content);
	}

	async createNewMarkdownFileFromLinktext(linktext: string, sourcePath: string) {
		const parent = this.getNewFileParent(sourcePath);
		const dir = nodePath.posix.dirname(linktext);
		const folderPath = dir === "." ? parent.path : normalizePath(`${parent.isRoot() ? "" : parent.path}/${dir}`);
		const folder = this.app.vault.getFolderByPath(folderPath) ?? (await this.app.vault.createFolder(folderPath));
		return this.createNewMarkdownFile(folder, nodePath.posix.basename(linktext));
	}

	async renameFile(file: TAbstractFile, newPath: string) {
		await this.app.vault.rename(file, newPath);
	}

	async trashFile(file: TAbstractFile) {
		await this.app.vault.trash(file, this.app.vault.getConfig("trashOption") !== "local");
	}

	generateMarkdownLink(file: TFile, sourcePath: string, subpath = "", alias?: string) {
		const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, true) + subpath;
		if (this.app.vault.getConfig("useMarkdownLinks")) {
			return `[${alias ?? file.basename}](${encodeURI(linktext)}${file.extension === "md" && !linktext.endsWith(".md") ? ".md" : ""})`;
		}
		return alias ? `[[${linktext}|${alias}]]` : `[[${linktext}]]`;
	}

	async processFrontMatter(file: TFile, fn: (frontmatter: any) => void) {
		await this.app.vault.process(file, (text) => {
			const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
			const data = (m ? parseYaml(m[1]) : null) ?? {};
			fn(data);
			const yaml = Object.keys(data).length ? `---\n${stringifyYaml(data)}---\n` : "";
			return m ? yaml + text.slice(m[0].length) : yaml + text;
		});
	}

	async getAvailablePathForAttachment(filename: string, sourcePath?: string) {
		const configured: string = this.app.vault.getConfig("attachmentFolderPath") ?? "/";
		let dir = configured;
		if (configured.startsWith("./")) dir = nodePath.posix.join(nodePath.posix.dirname(sourcePath ?? ""), configured.slice(2));
		dir = normalizePath(dir);
		const ext = nodePath.posix.extname(filename);
		const stem = filename.slice(0, filename.length - ext.length);
		const prefix = dir === "/" ? "" : `${dir}/`;
		let path = `${prefix}${filename}`;
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = `${prefix}${stem} ${i}${ext}`;
		return path;
	}
}
