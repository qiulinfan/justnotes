import * as fs from "node:fs";
import * as nodePath from "node:path";
import { Events } from "./events";
import { normalizePath } from "./util";

export interface Stat {
	ctime: number;
	mtime: number;
	size: number;
}

export abstract class TAbstractFile {
	vault: Vault;
	path: string;
	name: string;
	parent: TFolder | null = null;

	constructor(vault: Vault, path: string) {
		this.vault = vault;
		this.path = path;
		this.name = path === "/" ? "" : nodePath.posix.basename(path);
	}
}

export class TFile extends TAbstractFile {
	stat: Stat = { ctime: 0, mtime: 0, size: 0 };
	basename = "";
	extension = "";

	constructor(vault: Vault, path: string) {
		super(vault, path);
		this.setPath(path);
	}

	setPath(path: string) {
		this.path = path;
		this.name = nodePath.posix.basename(path);
		const dot = this.name.lastIndexOf(".");
		this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
		this.extension = dot > 0 ? this.name.slice(dot + 1) : "";
	}
}

export class TFolder extends TAbstractFile {
	children: TAbstractFile[] = [];

	isRoot() {
		return this.path === "/";
	}
}

export interface ListedFiles {
	files: string[];
	folders: string[];
}

// The vault-relative filesystem adapter. Paths are normalized vault paths.
export class FileSystemAdapter {
	basePath: string;

	constructor(basePath: string) {
		this.basePath = basePath;
	}

	getName() {
		return nodePath.basename(this.basePath);
	}

	getBasePath() {
		return this.basePath;
	}

	getFullPath(path: string) {
		return nodePath.join(this.basePath, normalizePath(path));
	}

	getFullRealPath(path: string) {
		return this.getFullPath(path);
	}

	getResourcePath(path: string) {
		return `file://${encodeURI(this.getFullPath(path))}?${Date.now()}`;
	}

	static readLocalFile(path: string) {
		return fs.promises.readFile(path).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
	}

	static mkdir(path: string) {
		return fs.promises.mkdir(path, { recursive: true });
	}

	async exists(path: string, _sensitive?: boolean) {
		try {
			await fs.promises.access(this.getFullPath(path));
			return true;
		} catch {
			return false;
		}
	}

	async stat(path: string) {
		try {
			const s = await fs.promises.stat(this.getFullPath(path));
			return { type: s.isDirectory() ? "folder" : "file", ctime: s.birthtimeMs, mtime: s.mtimeMs, size: s.size };
		} catch {
			return null;
		}
	}

	async list(path: string): Promise<ListedFiles> {
		const dir = normalizePath(path);
		const entries = await fs.promises.readdir(this.getFullPath(dir), { withFileTypes: true });
		const result: ListedFiles = { files: [], folders: [] };
		for (const e of entries) {
			const child = dir === "/" ? e.name : `${dir}/${e.name}`;
			(e.isDirectory() ? result.folders : result.files).push(child);
		}
		return result;
	}

	read(path: string) {
		return fs.promises.readFile(this.getFullPath(path), "utf8");
	}

	async readBinary(path: string) {
		const b = await fs.promises.readFile(this.getFullPath(path));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	}

	async write(path: string, data: string) {
		const full = this.getFullPath(path);
		await fs.promises.mkdir(nodePath.dirname(full), { recursive: true });
		await fs.promises.writeFile(full, data, "utf8");
	}

	async writeBinary(path: string, data: ArrayBuffer) {
		const full = this.getFullPath(path);
		await fs.promises.mkdir(nodePath.dirname(full), { recursive: true });
		await fs.promises.writeFile(full, new Uint8Array(data));
	}

	append(path: string, data: string) {
		return fs.promises.appendFile(this.getFullPath(path), data, "utf8");
	}

	async process(path: string, fn: (data: string) => string) {
		const data = fn(await this.read(path));
		await this.write(path, data);
		return data;
	}

	mkdir(path: string) {
		return fs.promises.mkdir(this.getFullPath(path), { recursive: true }).then(() => {});
	}

	remove(path: string) {
		return fs.promises.unlink(this.getFullPath(path));
	}

	rmdir(path: string, recursive: boolean) {
		return fs.promises.rm(this.getFullPath(path), { recursive, force: false });
	}

	async rename(from: string, to: string) {
		const target = this.getFullPath(to);
		await fs.promises.mkdir(nodePath.dirname(target), { recursive: true });
		await fs.promises.rename(this.getFullPath(from), target);
	}

	copy(from: string, to: string) {
		return fs.promises.cp(this.getFullPath(from), this.getFullPath(to), { recursive: true });
	}

	async trashSystem(path: string) {
		const { shell } = require("electron");
		await shell.trashItem(this.getFullPath(path));
		return true;
	}

	async trashLocal(path: string) {
		await this.rename(path, `.trash/${path}`);
	}
}

// Folders a vault never shows, matching Obsidian's hidden dot-folders.
const HIDDEN = (name: string) => name.startsWith(".") || name === "node_modules";

export class Vault extends Events {
	adapter: FileSystemAdapter;
	configDir = ".obsidian";
	config: Record<string, any> = {};
	fileMap: Record<string, TAbstractFile> = {};
	root: TFolder;
	// Paths this process just wrote, so the watcher does not report its own writes.
	#ownWrites = new Map<string, number>();
	#watcher: fs.FSWatcher | null = null;

	constructor(basePath: string) {
		super();
		this.adapter = new FileSystemAdapter(basePath);
		this.root = new TFolder(this, "/");
		this.fileMap["/"] = this.root;
	}

	async load() {
		try {
			this.config = JSON.parse(await this.adapter.read(`${this.configDir}/app.json`));
		} catch {
			this.config = {};
		}
		await this.#scan(this.root);
		this.#watch();
	}

	async #scan(folder: TFolder) {
		const dir = folder.isRoot() ? this.adapter.basePath : this.adapter.getFullPath(folder.path);
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		await Promise.all(
			entries.map(async (e) => {
				if (HIDDEN(e.name)) return;
				const path = folder.isRoot() ? e.name : `${folder.path}/${e.name}`;
				if (e.isDirectory()) {
					const child = new TFolder(this, path);
					this.#attach(child, folder);
					await this.#scan(child);
				} else if (e.isFile()) {
					const file = new TFile(this, path);
					await this.#refreshStat(file);
					this.#attach(file, folder);
				}
			}),
		);
	}

	async #refreshStat(file: TFile) {
		try {
			const s = await fs.promises.stat(this.adapter.getFullPath(file.path));
			file.stat = { ctime: s.birthtimeMs, mtime: s.mtimeMs, size: s.size };
		} catch {}
	}

	#attach(file: TAbstractFile, parent: TFolder) {
		file.parent = parent;
		parent.children.push(file);
		this.fileMap[file.path] = file;
	}

	#detach(file: TAbstractFile) {
		file.parent?.children.remove(file);
		Vault.recurseChildren(file as TFolder, (f) => delete this.fileMap[f.path]);
	}

	#markOwnWrite(path: string) {
		this.#ownWrites.set(path, Date.now());
	}

	#watch() {
		try {
			this.#watcher = fs.watch(this.adapter.basePath, { recursive: true }, (_event, filename) => {
				if (filename) this.#onExternalChange(filename.toString().split(nodePath.sep).join("/"));
			});
		} catch (err) {
			console.warn("Vault watcher unavailable", err);
		}
	}

	async #onExternalChange(path: string) {
		if (path.split("/").some(HIDDEN)) return;
		const own = this.#ownWrites.get(path);
		if (own && Date.now() - own < 1500) return;
		const existing = this.fileMap[path];
		const stat = await this.adapter.stat(path);
		if (!stat) {
			if (existing) {
				this.#detach(existing);
				this.trigger("delete", existing);
			}
			return;
		}
		if (existing instanceof TFile) {
			if (existing.stat.mtime === stat.mtime) return;
			existing.stat = { ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
			this.trigger("modify", existing);
		} else if (!existing) {
			const parent = await this.#ensureFolder(nodePath.posix.dirname(path));
			const created = stat.type === "folder" ? new TFolder(this, path) : new TFile(this, path);
			if (created instanceof TFile) created.stat = { ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
			this.#attach(created, parent);
			this.trigger("create", created);
			if (created instanceof TFolder) await this.#scan(created);
		}
	}

	async #ensureFolder(path: string): Promise<TFolder> {
		if (path === "." || path === "" || path === "/") return this.root;
		const existing = this.fileMap[path];
		if (existing instanceof TFolder) return existing;
		const parent = await this.#ensureFolder(nodePath.posix.dirname(path));
		const folder = new TFolder(this, path);
		this.#attach(folder, parent);
		this.trigger("create", folder);
		return folder;
	}

	getName() {
		return this.adapter.getName();
	}

	getRoot() {
		return this.root;
	}

	getConfig(key: string) {
		return this.config[key];
	}

	setConfig(key: string, value: any) {
		this.config[key] = value;
	}

	getAbstractFileByPath(path: string) {
		return this.fileMap[normalizePath(path)] ?? null;
	}

	getFileByPath(path: string) {
		const f = this.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}

	getFolderByPath(path: string) {
		const f = this.getAbstractFileByPath(path);
		return f instanceof TFolder ? f : null;
	}

	getAllLoadedFiles() {
		return Object.values(this.fileMap);
	}

	getAllFolders(includeRoot?: boolean) {
		return this.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && (includeRoot || !f.isRoot()));
	}

	getFiles() {
		return this.getAllLoadedFiles().filter((f): f is TFile => f instanceof TFile);
	}

	getMarkdownFiles() {
		return this.getFiles().filter((f) => f.extension === "md");
	}

	read(file: TFile) {
		return this.adapter.read(file.path);
	}

	cachedRead(file: TFile) {
		return this.adapter.read(file.path);
	}

	readBinary(file: TFile) {
		return this.adapter.readBinary(file.path);
	}

	getResourcePath(file: TFile) {
		return this.adapter.getResourcePath(file.path);
	}

	async create(path: string, data: string) {
		path = normalizePath(path);
		if (this.fileMap[path]) throw new Error("File already exists.");
		this.#markOwnWrite(path);
		await this.adapter.write(path, data);
		return this.#registerNewFile(path);
	}

	async createBinary(path: string, data: ArrayBuffer) {
		path = normalizePath(path);
		if (this.fileMap[path]) throw new Error("File already exists.");
		this.#markOwnWrite(path);
		await this.adapter.writeBinary(path, data);
		return this.#registerNewFile(path);
	}

	async #registerNewFile(path: string) {
		const parent = await this.#ensureFolder(nodePath.posix.dirname(path));
		const file = new TFile(this, path);
		await this.#refreshStat(file);
		this.#attach(file, parent);
		this.trigger("create", file);
		return file;
	}

	async createFolder(path: string) {
		path = normalizePath(path);
		if (this.fileMap[path]) throw new Error("Folder already exists.");
		this.#markOwnWrite(path);
		await this.adapter.mkdir(path);
		return this.#ensureFolder(path);
	}

	async modify(file: TFile, data: string) {
		this.#markOwnWrite(file.path);
		await this.adapter.write(file.path, data);
		await this.#refreshStat(file);
		this.trigger("modify", file);
	}

	async modifyBinary(file: TFile, data: ArrayBuffer) {
		this.#markOwnWrite(file.path);
		await this.adapter.writeBinary(file.path, data);
		await this.#refreshStat(file);
		this.trigger("modify", file);
	}

	async append(file: TFile, data: string) {
		this.#markOwnWrite(file.path);
		await this.adapter.append(file.path, data);
		await this.#refreshStat(file);
		this.trigger("modify", file);
	}

	async process(file: TFile, fn: (data: string) => string) {
		const data = fn(await this.read(file));
		await this.modify(file, data);
		return data;
	}

	async delete(file: TAbstractFile, force?: boolean) {
		this.#markOwnWrite(file.path);
		if (file instanceof TFolder) await this.adapter.rmdir(file.path, !!force);
		else await this.adapter.remove(file.path);
		this.#detach(file);
		this.trigger("delete", file);
	}

	async trash(file: TAbstractFile, system: boolean) {
		this.#markOwnWrite(file.path);
		if (system) await this.adapter.trashSystem(file.path);
		else await this.adapter.trashLocal(file.path);
		this.#detach(file);
		this.trigger("delete", file);
	}

	async rename(file: TAbstractFile, newPath: string) {
		newPath = normalizePath(newPath);
		const oldPath = file.path;
		this.#markOwnWrite(oldPath);
		this.#markOwnWrite(newPath);
		await this.adapter.rename(oldPath, newPath);
		this.#detach(file);
		const parent = await this.#ensureFolder(nodePath.posix.dirname(newPath));
		this.#move(file, newPath);
		this.#attach(file, parent);
		this.trigger("rename", file, oldPath);
	}

	#move(file: TAbstractFile, newPath: string) {
		if (file instanceof TFile) file.setPath(newPath);
		else {
			file.path = newPath;
			file.name = nodePath.posix.basename(newPath);
		}
		if (file instanceof TFolder) {
			for (const child of file.children) {
				this.#move(child, `${newPath}/${child.name}`);
				this.fileMap[child.path] = child;
			}
		}
	}

	async copy(file: TFile, newPath: string) {
		return this.create(newPath, await this.read(file));
	}

	static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any) {
		const stack: TAbstractFile[] = [root];
		while (stack.length) {
			const f = stack.pop()!;
			cb(f);
			if (f instanceof TFolder) stack.push(...f.children);
		}
	}

	close() {
		this.#watcher?.close();
	}
}
