import * as fs from "node:fs";
import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { Events } from "./events";
import { normalizePath } from "./util";

export interface FileStats {
	ctime: number;
	mtime: number;
	size: number;
}

export interface Stat extends FileStats {
	type: "file" | "folder";
}

export interface DataWriteOptions {
	ctime?: number;
	mtime?: number;
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
	stat: FileStats = { ctime: 0, mtime: 0, size: 0 };
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

// A file outside the vault. Only the class exists so `instanceof` checks work;
// justnotes has no flow that opens external files yet.
export class TExternalFile extends TFile {
	#realPath: string;

	constructor(vault: Vault, path: string, realPath: string) {
		super(vault, path);
		this.#realPath = realPath;
	}

	getRealPath() {
		return this.#realPath;
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

interface FileEntry extends FileStats {
	type: "file" | "folder";
	// The vault-relative path as spelled on disk, which can differ from the
	// normalized key in Unicode form or in a non-breaking space.
	realpath: string;
}

interface Watcher {
	path: string;
	close(): void;
}

// What the adapter reports to its vault.
export type AdapterChange = (type: string, path: string, oldPath?: string, stat?: FileStats) => void;

// Dot-prefixed files and folders (the config dir, .git, .trash) and
// node_modules never enter the vault's file tree.
const HIDDEN = (name: string) => name.startsWith(".") || name === "node_modules";
const isHidden = (path: string) => path.split("/").some(HIDDEN);

// Adapter paths are vault-relative without a leading slash; the root is "".
const key = (path: string) => {
	const p = normalizePath(path);
	return p === "/" ? "" : p;
};
const join = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const missing = (err: any) => err?.code === "ENOENT" || err?.code === "ENOTDIR" || err?.code === "ELOOP";
const birth = (s: fs.Stats) => s.birthtimeMs || s.ctimeMs;

// A watcher-reported deletion waits this long, so a file that an editor or git
// replaces by delete-then-create reads as one modification.
const DELETE_GRACE = 100;

// The desktop adapter. It owns the file table and the watchers, and reports
// every change of a visible path to the vault through one handler, whether the
// change came from the watcher, from the vault API or from an adapter call.
// kgdistiller swaps listRecursiveChild and reconcileFile for wrappers to index
// its hidden folder, so the scanner and the watcher call them through `this`.
export class FileSystemAdapter {
	basePath: string;
	files: Record<string, FileEntry> = {};
	watchers: Record<string, Watcher> = {};
	insensitive = false;
	#handler: AdapterChange | null = null;
	#queues = new Map<string, Promise<unknown>>();
	#written = new Map<string, DataWriteOptions>();
	#pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(basePath: string) {
		this.basePath = basePath;
	}

	getName() {
		return nodePath.basename(this.basePath);
	}

	getBasePath() {
		return this.basePath;
	}

	getFullPath(normalizedPath: string) {
		return nodePath.join(this.basePath, this.#realPath(key(normalizedPath)));
	}

	getFullRealPath(normalizedPath: string) {
		return this.getFullPath(normalizedPath);
	}

	getFilePath(normalizedPath: string) {
		return pathToFileURL(this.getFullPath(normalizedPath)).href;
	}

	// Stable until the file changes, so the browser keeps its cached copy.
	getResourcePath(normalizedPath: string) {
		const full = this.getFullPath(normalizedPath);
		let mtime = this.files[key(normalizedPath)]?.mtime;
		if (mtime === undefined) {
			try {
				mtime = fs.statSync(full).mtimeMs;
			} catch {}
		}
		const url = pathToFileURL(full).href;
		return mtime === undefined ? url : `${url}?${Math.round(mtime)}`;
	}

	static readLocalFile(path: string) {
		return fs.promises.readFile(path).then((b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
	}

	static mkdir(path: string) {
		return fs.promises.mkdir(path, { recursive: true }).then(() => {});
	}

	#realPath(norm: string): string {
		if (!norm) return "";
		const entry = this.files[norm];
		if (entry) return entry.realpath;
		const i = norm.lastIndexOf("/");
		return i < 0 ? norm : `${this.#realPath(norm.slice(0, i))}/${norm.slice(i + 1)}`;
	}

	#abs(realPath: string) {
		return nodePath.join(this.basePath, realPath);
	}

	async exists(normalizedPath: string, sensitive?: boolean) {
		const norm = key(normalizedPath);
		try {
			await fs.promises.access(this.getFullPath(norm));
		} catch {
			return false;
		}
		if (!sensitive || !this.insensitive || !norm) return true;
		// Every segment must exist with exactly this case.
		const real = this.#realPath(norm).split("/");
		for (let i = 0; i < real.length; i++) {
			if (!(await this.#hasName(real.slice(0, i + 1).join("/")))) return false;
		}
		return true;
	}

	// Whether the folder holds an entry spelled exactly like the path's last segment.
	async #hasName(realPath: string) {
		try {
			const names = await fs.promises.readdir(this.#abs(parentOf(realPath)));
			const want = nameOf(realPath).normalize("NFC");
			return names.some((n) => n.normalize("NFC") === want);
		} catch {
			return false;
		}
	}

	async stat(normalizedPath: string): Promise<Stat | null> {
		const norm = key(normalizedPath);
		try {
			const s = await fs.promises.stat(this.getFullPath(norm));
			const folder = s.isDirectory();
			return { type: folder ? "folder" : "file", ctime: this.files[norm]?.ctime ?? birth(s), mtime: s.mtimeMs, size: folder ? 0 : s.size };
		} catch {
			return null;
		}
	}

	// Symlinks are followed, so a linked plugin or note folder counts as a folder.
	async list(normalizedPath: string): Promise<ListedFiles> {
		const dir = key(normalizedPath);
		const full = this.getFullPath(dir);
		const entries = await fs.promises.readdir(full, { withFileTypes: true });
		const kinds = await Promise.all(
			entries.map(async (e) => {
				if (!e.isSymbolicLink()) return e.isDirectory() ? "folder" : "file";
				try {
					return (await fs.promises.stat(nodePath.join(full, e.name))).isDirectory() ? "folder" : "file";
				} catch {
					return null;
				}
			}),
		);
		const result: ListedFiles = { files: [], folders: [] };
		entries.forEach((e, i) => {
			const kind = kinds[i];
			if (kind) (kind === "folder" ? result.folders : result.files).push(key(join(dir, e.name)));
		});
		return result;
	}

	read(normalizedPath: string) {
		return fs.promises.readFile(this.getFullPath(normalizedPath), "utf8");
	}

	async readBinary(normalizedPath: string) {
		const b = await fs.promises.readFile(this.getFullPath(normalizedPath));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	}

	write(normalizedPath: string, data: string, options?: DataWriteOptions) {
		return this.#mutate(normalizedPath, (full) => fs.promises.writeFile(full, data, "utf8"), options);
	}

	writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions) {
		return this.#mutate(normalizedPath, (full) => fs.promises.writeFile(full, new Uint8Array(data)), options);
	}

	append(normalizedPath: string, data: string, options?: DataWriteOptions) {
		return this.#mutate(normalizedPath, (full) => fs.promises.appendFile(full, data, "utf8"), options);
	}

	appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions) {
		return this.#mutate(normalizedPath, (full) => fs.promises.appendFile(full, new Uint8Array(data)), options);
	}

	// Serialized with every other write to the path, so no write lands between
	// the read and the save. An unchanged result is not written.
	process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions) {
		const norm = key(normalizedPath);
		return this.#serial(norm, async () => {
			const full = this.getFullPath(norm);
			const before = await fs.promises.readFile(full, "utf8");
			const data = fn(before);
			if (data !== before) {
				await fs.promises.writeFile(full, data, "utf8");
				await this.#reconcileWrite(norm, full, options);
			}
			return data;
		});
	}

	#mutate(normalizedPath: string, write: (full: string) => Promise<void>, options?: DataWriteOptions) {
		const norm = key(normalizedPath);
		return this.#serial(norm, async () => {
			const full = this.getFullPath(norm);
			await fs.promises.mkdir(nodePath.dirname(full), { recursive: true });
			await write(full);
			await this.#reconcileWrite(norm, full, options);
		});
	}

	// Node cannot set a birth time, so a requested ctime is kept in the file table.
	async #reconcileWrite(norm: string, full: string, options?: DataWriteOptions) {
		if (options?.mtime !== undefined) await fs.promises.utimes(full, new Date(), new Date(options.mtime));
		this.#written.set(norm, options ?? {});
		try {
			await this.reconcileFile(this.#realPath(norm), norm, true);
		} finally {
			this.#written.delete(norm);
		}
	}

	mkdir(normalizedPath: string) {
		const norm = key(normalizedPath);
		return this.#serial(norm, async () => {
			await fs.promises.mkdir(this.getFullPath(norm), { recursive: true });
			await this.reconcileFile(this.#realPath(norm), norm, true);
		});
	}

	remove(normalizedPath: string) {
		const norm = key(normalizedPath);
		return this.#serial(norm, async () => {
			await fs.promises.unlink(this.getFullPath(norm));
			await this.reconcileFile(this.#realPath(norm), norm, true);
		});
	}

	rmdir(normalizedPath: string, recursive: boolean) {
		const norm = key(normalizedPath);
		return this.#serial(norm, async () => {
			const full = this.getFullPath(norm);
			if (recursive) await fs.promises.rm(full, { recursive: true });
			else await fs.promises.rmdir(full);
			await this.reconcileFile(this.#realPath(norm), norm, true);
		});
	}

	rename(normalizedPath: string, normalizedNewPath: string) {
		const from = key(normalizedPath);
		const to = key(normalizedNewPath);
		return this.#serial(from, async () => {
			if (from === to) return;
			const src = this.getFullPath(from);
			const dst = this.getFullPath(to);
			await this.#assertFree(dst, src);
			await fs.promises.mkdir(nodePath.dirname(dst), { recursive: true });
			// A new parent is registered while still empty; listing it after the
			// move would report the moved file as a second, new one.
			if (!isHidden(to)) await this.#ensureParent(to);
			await fs.promises.rename(src, dst);
			await this.#reconcileMove(from, to);
		});
	}

	copy(normalizedPath: string, normalizedNewPath: string) {
		const from = key(normalizedPath);
		const to = key(normalizedNewPath);
		return this.#serial(to, async () => {
			const dst = this.getFullPath(to);
			await this.#assertFree(dst);
			await fs.promises.mkdir(nodePath.dirname(dst), { recursive: true });
			await fs.promises.cp(this.getFullPath(from), dst, { recursive: true, force: false, errorOnExist: true });
			await this.reconcileFile(this.#realPath(to), to, true);
		});
	}

	// The destination must not exist, unless it is the source itself under
	// another case or Unicode form (a case-only rename on APFS).
	async #assertFree(dst: string, src?: string) {
		let target: fs.Stats;
		try {
			target = await fs.promises.lstat(dst);
		} catch {
			return;
		}
		const source = src ? await fs.promises.lstat(src).catch(() => null) : null;
		if (source && source.ino === target.ino && source.dev === target.dev) return;
		throw new Error("Destination file already exists!");
	}

	async trashSystem(normalizedPath: string) {
		const norm = key(normalizedPath);
		try {
			await require("electron").shell.trashItem(this.getFullPath(norm));
		} catch {
			return false;
		}
		await this.#serial(norm, () => this.reconcileFile(this.#realPath(norm), norm, true));
		return true;
	}

	// Moves the item into .trash at the vault root under a free name.
	async trashLocal(normalizedPath: string) {
		const norm = key(normalizedPath);
		const name = nameOf(norm);
		const folder = (await fs.promises.lstat(this.getFullPath(norm))).isDirectory();
		const dot = folder ? -1 : name.lastIndexOf(".");
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		let target = `.trash/${name}`;
		for (let i = 1; await this.#taken(target); i++) target = `.trash/${stem} ${i}${ext}`;
		await this.rename(norm, target);
	}

	async #taken(path: string) {
		try {
			await fs.promises.lstat(this.getFullPath(path));
			return true;
		} catch {
			return false;
		}
	}

	// Runs tasks for one path one after another: watcher events, writes and
	// their reconciliation never interleave on the same path.
	#serial<T>(norm: string, task: () => Promise<T>): Promise<T> {
		const run = (this.#queues.get(norm) ?? Promise.resolve()).then(task, task);
		const tail = run.then(
			() => {},
			() => {},
		);
		this.#queues.set(norm, tail);
		tail.then(() => {
			if (this.#queues.get(norm) === tail) this.#queues.delete(norm);
		});
		return run;
	}

	// Sets the vault's change handler and starts watching the vault folder.
	async watch(handler: AdapterChange) {
		this.#handler = handler;
		this.#watchDir("", this.basePath);
	}

	trigger(type: string, path: string, oldPath?: string, stat?: FileStats) {
		this.#handler?.(type, path, oldPath, stat);
	}

	#watchDir(path: string, dir: string) {
		let fsWatcher: fs.FSWatcher | null = null;
		const watcher: Watcher = { path, close: () => fsWatcher?.close() };
		try {
			fsWatcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
				if (filename) this.#onWatch(watcher.path, String(filename));
			});
		} catch (err) {
			console.warn("Vault watcher unavailable", dir, err);
			return;
		}
		fsWatcher.on("error", (err) => this.#onWatchError(watcher, dir, err));
		this.watchers[path] = watcher;
	}

	// Every change is announced as 'raw', hidden paths included; only visible
	// paths and watched hidden folders are reconciled into the file table.
	#onWatch(prefix: string, filename: string) {
		const realPath = join(this.#realPath(prefix), filename.split(nodePath.sep).join("/"));
		const norm = key(realPath);
		this.trigger("raw", norm);
		if (isHidden(norm) && !Object.keys(this.watchers).some((w) => w && (norm === w || norm.startsWith(`${w}/`)))) return;
		this.#serial(norm, () => this.reconcileFile(realPath, norm)).catch((err) => console.error("Vault: could not reconcile", norm, err));
	}

	#onWatchError(watcher: Watcher, dir: string, err: unknown) {
		console.warn("Vault watcher failed", dir, err);
		watcher.close();
		if (this.watchers[watcher.path] === watcher) delete this.watchers[watcher.path];
		if (watcher.path) return;
		try {
			fs.accessSync(this.basePath);
			this.#watchDir("", this.basePath);
			this.listRecursive("").catch((e) => console.error("Vault: rescan failed", e));
		} catch {
			this.trigger("closed", "");
		}
	}

	// The root watcher sees hidden folders too; watching one only lets its
	// changes reach reconcileFile.
	async watchHiddenRecursive(path: string) {
		const norm = key(path);
		this.watchers[norm] ??= { path: norm, close() {} };
	}

	stopWatchPath(path: string) {
		const norm = key(path);
		this.watchers[norm]?.close();
		delete this.watchers[norm];
	}

	async listRecursive(path: string) {
		await this.#list(path, false);
	}

	async #list(realPath: string, fresh: boolean) {
		let names: string[];
		try {
			names = await fs.promises.readdir(this.#abs(realPath));
		} catch (err) {
			if (missing(err)) return;
			throw err;
		}
		if (!fresh) {
			const norm = key(realPath);
			const present = new Set(names.map((n) => key(join(norm, n))));
			const prefix = norm ? `${norm}/` : "";
			for (const p of Object.keys(this.files)) {
				if (!p.startsWith(prefix) || p.includes("/", prefix.length) || present.has(p)) continue;
				const entry = this.files[p];
				if (entry) await this.reconcileDeletion(entry.realpath, p, true);
			}
		}
		await Promise.all(names.map((name) => this.listRecursiveChild(realPath, name)));
	}

	async listRecursiveChild(parentPath: string, name: string) {
		if (HIDDEN(name)) return;
		const realPath = join(parentPath, name);
		const normalizedPath = key(realPath);
		const known = this.files[normalizedPath]?.type === "folder";
		await this.reconcileFileInternal(realPath, normalizedPath);
		if (known) await this.#list(realPath, false);
	}

	async reconcileFile(realPath: string, normalizedPath: string, skipTimeout?: boolean) {
		if (isHidden(normalizedPath)) return;
		if (await this.#present(realPath)) await this.reconcileFileInternal(realPath, normalizedPath);
		else await this.reconcileDeletion(realPath, normalizedPath, skipTimeout);
	}

	// On a case-insensitive volume a stat also finds the old name after a
	// case-only rename, so the exact name must be in its folder.
	async #present(realPath: string) {
		try {
			await fs.promises.stat(this.#abs(realPath));
		} catch (err) {
			if (missing(err)) return false;
			throw err;
		}
		return !this.insensitive || this.#hasName(realPath);
	}

	async reconcileFileInternal(realPath: string, normalizedPath: string) {
		if (!normalizedPath) return;
		// An own write reports 'modified' even when the stat looks unchanged,
		// but only for an entry that existed before it.
		const written = this.#written.get(normalizedPath);
		const before = this.files[normalizedPath];
		let s: fs.Stats;
		try {
			s = await fs.promises.stat(this.#abs(realPath));
		} catch (err) {
			if (missing(err)) return this.reconcileDeletion(realPath, normalizedPath, true);
			throw err;
		}
		if (s.isDirectory()) return this.reconcileFolderCreation(realPath, normalizedPath);
		this.#cancelDelete(normalizedPath);
		await this.#ensureParent(normalizedPath);
		if (this.files[normalizedPath]?.type === "folder") await this.reconcileDeletion(realPath, normalizedPath, true);
		const entry = this.files[normalizedPath];
		if (!entry) {
			const stat = { ctime: written?.ctime ?? birth(s), mtime: s.mtimeMs, size: s.size };
			this.files[normalizedPath] = { type: "file", realpath: realPath, ...stat };
			this.trigger("file-created", normalizedPath, undefined, { ...stat });
		} else if ((written && entry === before) || entry.mtime !== s.mtimeMs || entry.size !== s.size) {
			const stat = { ctime: written?.ctime ?? entry.ctime, mtime: s.mtimeMs, size: s.size };
			Object.assign(entry, stat, { realpath: realPath });
			this.trigger("modified", normalizedPath, undefined, { ...stat });
		}
	}

	async reconcileFolderCreation(realPath: string, normalizedPath: string) {
		if (!normalizedPath) return;
		this.#cancelDelete(normalizedPath);
		await this.#ensureParent(normalizedPath);
		const entry = this.files[normalizedPath];
		if (entry?.type === "folder") return;
		if (entry) await this.reconcileDeletion(entry.realpath, normalizedPath, true);
		const full = this.#abs(realPath);
		let s: fs.Stats;
		let target: string | null = null;
		try {
			if ((await fs.promises.lstat(full)).isSymbolicLink()) {
				target = await fs.promises.realpath(full);
				if (await this.#cyclic(normalizedPath, target)) return;
			}
			s = await fs.promises.stat(full);
		} catch (err) {
			if (missing(err)) return;
			throw err;
		}
		if (!s.isDirectory() || this.files[normalizedPath]) return;
		this.files[normalizedPath] = { type: "folder", realpath: realPath, ctime: birth(s), mtime: s.mtimeMs, size: 0 };
		this.trigger("folder-created", normalizedPath);
		// The vault watcher does not follow links, so a linked folder needs its own.
		if (target) this.#watchDir(normalizedPath, target);
		await this.#list(realPath, true);
	}

	// A link to one of its own ancestors would make the tree infinite.
	async #cyclic(normalizedPath: string, target: string) {
		for (let p = parentOf(normalizedPath); ; p = parentOf(p)) {
			const real = await fs.promises.realpath(this.#abs(this.#realPath(p))).catch(() => null);
			if (real && (real === target || real.startsWith(target + nodePath.sep))) return true;
			if (!p) return false;
		}
	}

	async #ensureParent(normalizedPath: string) {
		const parent = parentOf(normalizedPath);
		if (!parent || this.files[parent]?.type === "folder") return;
		await this.reconcileFolderCreation(this.#realPath(parent), parent);
	}

	// Removes the entry and everything below it, deepest first, reporting each.
	async reconcileDeletion(realPath: string, normalizedPath: string, skipTimeout?: boolean) {
		if (!this.files[normalizedPath]) return;
		if (!skipTimeout) return this.#deleteLater(realPath, normalizedPath);
		const prefix = `${normalizedPath}/`;
		const doomed = Object.keys(this.files)
			.filter((p) => p.startsWith(prefix))
			.sort((a, b) => b.length - a.length);
		doomed.push(normalizedPath);
		for (const p of doomed) {
			const entry = this.files[p];
			if (!entry) continue;
			delete this.files[p];
			this.#cancelDelete(p);
			if (p && this.watchers[p]) this.stopWatchPath(p);
			this.trigger(entry.type === "folder" ? "folder-removed" : "file-removed", p);
		}
	}

	#deleteLater(realPath: string, normalizedPath: string) {
		if (this.#pendingDeletes.has(normalizedPath)) return;
		const timer = setTimeout(() => {
			this.#pendingDeletes.delete(normalizedPath);
			this.#serial(normalizedPath, async () => {
				if (await this.#present(realPath)) await this.reconcileFileInternal(realPath, normalizedPath);
				else await this.reconcileDeletion(realPath, normalizedPath, true);
			}).catch((err) => console.error("Vault: could not reconcile", normalizedPath, err));
		}, DELETE_GRACE);
		this.#pendingDeletes.set(normalizedPath, timer);
	}

	#cancelDelete(normalizedPath: string) {
		const timer = this.#pendingDeletes.get(normalizedPath);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.#pendingDeletes.delete(normalizedPath);
	}

	// A move inside the file table keeps the entries and reports one rename; a
	// move out of view is a deletion and a move into view a creation.
	async #reconcileMove(from: string, to: string) {
		const entry = this.files[from];
		const parent = parentOf(to);
		if (!isHidden(to)) await this.#ensureParent(to);
		if (entry && !HIDDEN(nameOf(to)) && (!parent || this.files[parent]?.type === "folder")) {
			this.#rekey(from, to);
			this.trigger("renamed", to, from);
			return;
		}
		if (entry) await this.reconcileDeletion(entry.realpath, from, true);
		await this.reconcileFile(this.#realPath(to), to, true);
	}

	#rekey(from: string, to: string) {
		const fromReal = this.files[from].realpath;
		const toReal = this.#realPath(to);
		const prefix = `${from}/`;
		for (const p of Object.keys(this.files)) {
			if (p !== from && !p.startsWith(prefix)) continue;
			const entry = this.files[p];
			delete this.files[p];
			entry.realpath = toReal + entry.realpath.slice(fromReal.length);
			this.files[to + p.slice(from.length)] = entry;
		}
		for (const p of Object.keys(this.watchers)) {
			if (p !== from && !p.startsWith(prefix)) continue;
			const watcher = this.watchers[p];
			delete this.watchers[p];
			watcher.path = to + p.slice(from.length);
			this.watchers[watcher.path] = watcher;
		}
	}

	stopWatching() {
		for (const p of Object.keys(this.watchers)) this.stopWatchPath(p);
		for (const timer of this.#pendingDeletes.values()) clearTimeout(timer);
		this.#pendingDeletes.clear();
	}
}

// Obsidian's defaults for the settings that app.json and appearance.json leave
// unset, as its settings screens show them.
const DEFAULT_CONFIG: Record<string, unknown> = {
	accentColor: "",
	alwaysUpdateLinks: false,
	attachmentFolderPath: "/",
	autoPairBrackets: true,
	autoPairMarkdown: true,
	baseFontSize: 16,
	cssTheme: "",
	defaultViewMode: "source",
	enabledCssSnippets: [],
	foldHeading: true,
	foldIndent: true,
	interfaceFontFamily: "",
	legacyEditor: false,
	livePreview: true,
	monospaceFontFamily: "",
	newFileFolderPath: "",
	newFileLocation: "root",
	newLinkFormat: "shortest",
	promptDelete: true,
	propertiesInDocument: "visible",
	readableLineLength: true,
	rightToLeft: false,
	showIndentGuide: true,
	showInlineTitle: true,
	showLineNumber: false,
	showUnsupportedFiles: false,
	smartIndentList: true,
	strictLineBreaks: false,
	tabSize: 4,
	textFontFamily: "",
	theme: "system",
	translucency: false,
	trashOption: "system",
	useMarkdownLinks: false,
	useTab: true,
	userIgnoreFilters: [],
	vimMode: false,
};

// A case-insensitive volume finds the vault folder under a flipped case.
async function detectInsensitive(dir: string) {
	const flip = (s: string) => [...s].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
	const name = nodePath.basename(dir);
	const other = flip(name) !== name ? nodePath.join(nodePath.dirname(dir), flip(name)) : flip(dir);
	if (other === dir) return false;
	try {
		const [a, b] = await Promise.all([fs.promises.stat(dir), fs.promises.stat(other)]);
		return a.ino === b.ino && a.dev === b.dev;
	} catch {
		return false;
	}
}

export class Vault extends Events {
	adapter: FileSystemAdapter;
	configDir = ".obsidian";
	config: Record<string, any> = {};
	fileMap: Record<string, TAbstractFile> = {};
	root: TFolder;
	// Lowercased path to file, for collision checks on case-insensitive volumes.
	#lower = new Map<string, TAbstractFile>();
	#contents = new Map<string, { mtime: number; size: number; text: string }>();
	// setConfig values: kept in memory, never written to app.json.
	#overrides: Record<string, unknown> = {};
	#configTimer: ReturnType<typeof setTimeout> | null = null;
	#loading = false;

	constructor(basePath: string) {
		super();
		this.adapter = new FileSystemAdapter(basePath);
		this.root = new TFolder(this, "/");
		this.fileMap["/"] = this.root;
		this.#lower.set("/", this.root);
	}

	// Startup indexing does not fire 'create': no plugin is loaded yet, and the
	// metadata cache indexes every note in its own initial pass.
	async load() {
		await this.#loadConfig();
		this.adapter.insensitive = await detectInsensitive(this.adapter.basePath);
		this.#loading = true;
		try {
			await this.adapter.watch(this.#onChange);
			await this.adapter.listRecursive("");
		} finally {
			this.#loading = false;
		}
	}

	async #loadConfig() {
		const read = async (name: string) => {
			try {
				const value = JSON.parse(await this.adapter.read(`${this.configDir}/${name}`));
				return value && typeof value === "object" ? value : {};
			} catch {
				return {};
			}
		};
		const [appearance, app] = await Promise.all([read("appearance.json"), read("app.json")]);
		this.config = { ...appearance, ...app, ...this.#overrides };
	}

	#onChange = (type: string, path: string, oldPath?: string, stat?: FileStats) => {
		if (type === "raw") this.#onRaw(path);
		else if (type === "file-created" || type === "folder-created") this.#onCreated(path, type === "folder-created", stat);
		else if (type === "modified") this.#onModified(path, stat);
		else if (type === "file-removed" || type === "folder-removed") this.#onRemoved(path);
		else if (type === "renamed" && oldPath !== undefined) this.#onRenamed(path, oldPath);
		else if (type === "closed") this.trigger("closed");
	};

	#onRaw(path: string) {
		this.trigger("raw", path);
		if (path !== `${this.configDir}/app.json` && path !== `${this.configDir}/appearance.json`) return;
		if (this.#configTimer) clearTimeout(this.#configTimer);
		this.#configTimer = setTimeout(async () => {
			this.#configTimer = null;
			await this.#loadConfig();
			this.trigger("config-changed");
		}, 100);
	}

	#onCreated(path: string, folder: boolean, stat?: FileStats) {
		const existing = this.fileMap[path];
		if (existing && existing instanceof TFolder === folder) return;
		if (existing) this.#onRemoved(path);
		const parent = this.#folderAt(parentOf(path));
		const file = folder ? new TFolder(this, path) : new TFile(this, path);
		if (file instanceof TFile && stat) file.stat = { ...stat };
		this.#attach(file, parent);
		if (!this.#loading) this.trigger("create", file);
	}

	// The adapter reports parents first; a missing one is created as a fallback.
	#folderAt(path: string): TFolder {
		const folder = path ? this.fileMap[path] : this.root;
		if (folder instanceof TFolder) return folder;
		this.#onCreated(path, true);
		return this.fileMap[path] as TFolder;
	}

	#onModified(path: string, stat?: FileStats) {
		const file = this.fileMap[path];
		if (!(file instanceof TFile)) return;
		if (stat) file.stat = { ...stat };
		this.#contents.delete(path);
		this.trigger("modify", file);
	}

	#onRemoved(path: string) {
		const file = this.fileMap[path];
		if (!file) return;
		if (file instanceof TFolder) for (const child of [...file.children]) this.#onRemoved(child.path);
		this.#detach(file);
		this.trigger("delete", file);
	}

	// One adapter rename moves a whole folder; plugins index by path, so each
	// descendant gets its own 'rename' with its old path, after the tree moved.
	#onRenamed(path: string, oldPath: string) {
		const file = this.fileMap[oldPath];
		if (!file) {
			const entries = Object.entries(this.adapter.files).filter(([p]) => p === path || p.startsWith(`${path}/`));
			for (const [p, e] of entries.sort(([a], [b]) => a.length - b.length)) {
				this.#onCreated(p, e.type === "folder", { ctime: e.ctime, mtime: e.mtime, size: e.size });
			}
			return;
		}
		const moved: [TAbstractFile, string][] = [];
		Vault.recurseChildren(file as TFolder, (f) => moved.push([f, f.path]));
		this.#unlink(file);
		for (const [f, old] of moved) this.#unindex(f, old);
		this.#setPath(file, path);
		const stale = this.fileMap[path];
		if (stale && stale !== file) this.#onRemoved(path);
		const parent = this.#folderAt(parentOf(path));
		file.parent = parent;
		parent.children.push(file);
		for (const [f, old] of moved) {
			this.#index(f);
			const text = this.#contents.get(old);
			this.#contents.delete(old);
			if (text) this.#contents.set(f.path, text);
		}
		for (const [f, old] of moved) this.trigger("rename", f, old);
	}

	#setPath(file: TAbstractFile, path: string) {
		if (file instanceof TFile) file.setPath(path);
		else {
			file.path = path;
			file.name = nodePath.posix.basename(path);
		}
		if (file instanceof TFolder) for (const child of file.children) this.#setPath(child, `${path}/${child.name}`);
	}

	#attach(file: TAbstractFile, parent: TFolder) {
		file.parent = parent;
		parent.children.push(file);
		this.#index(file);
	}

	#detach(file: TAbstractFile) {
		this.#unlink(file);
		this.#unindex(file, file.path);
		this.#contents.delete(file.path);
	}

	#unlink(file: TAbstractFile) {
		const siblings = file.parent?.children;
		const i = siblings ? siblings.indexOf(file) : -1;
		if (siblings && i >= 0) siblings.splice(i, 1);
	}

	#index(file: TAbstractFile) {
		this.fileMap[file.path] = file;
		this.#lower.set(file.path.toLowerCase(), file);
	}

	#unindex(file: TAbstractFile, path: string) {
		if (this.fileMap[path] === file) delete this.fileMap[path];
		const lower = path.toLowerCase();
		if (this.#lower.get(lower) === file) this.#lower.delete(lower);
	}

	getName() {
		return this.adapter.getName();
	}

	getRoot() {
		return this.root;
	}

	getConfig(key: string) {
		const value = key in this.config ? this.config[key] : DEFAULT_CONFIG[key];
		return Array.isArray(value) ? [...value] : value;
	}

	setConfig(key: string, value: any) {
		if (value === undefined) {
			delete this.#overrides[key];
			delete this.config[key];
		} else {
			this.#overrides[key] = value;
			this.config[key] = value;
		}
		this.trigger("config-changed", key);
	}

	getAbstractFileByPath(path: string) {
		return this.fileMap[normalizePath(path)] ?? null;
	}

	getAbstractFileByPathInsensitive(path: string) {
		const p = normalizePath(path);
		return this.fileMap[p] ?? this.#lower.get(p.toLowerCase()) ?? null;
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

	// A free path 'name.ext', 'name 1.ext', 'name 2.ext', ...; `path` has no extension.
	getAvailablePath(path: string, extension: string) {
		const ext = extension ? `.${extension}` : "";
		let candidate = normalizePath(`${path}${ext}`);
		for (let i = 1; this.#taken(candidate); i++) candidate = normalizePath(`${path} ${i}${ext}`);
		return candidate;
	}

	#taken(path: string) {
		return !!this.fileMap[path] || (this.adapter.insensitive && this.#lower.has(path.toLowerCase()));
	}

	#newPath(path: string, message: string) {
		path = normalizePath(path);
		if (this.#taken(path)) throw new Error(message);
		return path;
	}

	async read(file: TFile) {
		const { mtime, size } = file.stat;
		const text = await this.adapter.read(file.path);
		if (file.stat.mtime === mtime && file.stat.size === size) this.#remember(file, text);
		return text;
	}

	async cachedRead(file: TFile) {
		const hit = this.#contents.get(file.path);
		if (hit && hit.mtime === file.stat.mtime && hit.size === file.stat.size) return hit.text;
		return this.read(file);
	}

	#remember(file: TFile, text: string) {
		if (this.fileMap[file.path] === file) this.#contents.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, text });
	}

	readBinary(file: TFile) {
		return this.adapter.readBinary(file.path);
	}

	getResourcePath(file: TFile) {
		return this.adapter.getResourcePath(file.path);
	}

	async create(path: string, data: string, options?: DataWriteOptions) {
		path = this.#newPath(path, "File already exists.");
		await this.adapter.write(path, data, options);
		const file = await this.#fileAt(path);
		this.#remember(file, data);
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions) {
		path = this.#newPath(path, "File already exists.");
		await this.adapter.writeBinary(path, data, options);
		return this.#fileAt(path);
	}

	// A hidden path stays out of the file tree; the caller still gets a file object.
	async #fileAt(path: string) {
		const file = this.fileMap[path];
		if (file instanceof TFile) return file;
		const detached = new TFile(this, path);
		const stat = await this.adapter.stat(path);
		if (stat) detached.stat = { ctime: stat.ctime, mtime: stat.mtime, size: stat.size };
		return detached;
	}

	async createFolder(path: string) {
		path = this.#newPath(path, "Folder already exists.");
		await this.adapter.mkdir(path);
		const folder = this.fileMap[path];
		return folder instanceof TFolder ? folder : new TFolder(this, path);
	}

	async modify(file: TFile, data: string, options?: DataWriteOptions) {
		await this.adapter.write(file.path, data, options);
		this.#remember(file, data);
	}

	async modifyBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions) {
		await this.adapter.writeBinary(file.path, data, options);
	}

	async append(file: TFile, data: string, options?: DataWriteOptions) {
		await this.adapter.append(file.path, data, options);
	}

	async appendBinary(file: TFile, data: ArrayBuffer, options?: DataWriteOptions) {
		await this.adapter.appendBinary(file.path, data, options);
	}

	async process(file: TFile, fn: (data: string) => string, options?: DataWriteOptions) {
		const data = await this.adapter.process(file.path, fn, options);
		this.#remember(file, data);
		return data;
	}

	// Without force a folder is emptied of its visible files first, so hidden
	// leftovers keep it (and fail the call) instead of being deleted unseen.
	async delete(file: TAbstractFile, force?: boolean) {
		if (!(file instanceof TFolder)) return this.adapter.remove(file.path);
		if (file.isRoot()) throw new Error("Cannot delete the vault root.");
		if (force) return this.adapter.rmdir(file.path, true);
		await this.#deleteTree(file);
	}

	// A symlinked folder is unlinked, never emptied: its files live elsewhere.
	async #deleteTree(folder: TFolder) {
		if ((await fs.promises.lstat(this.adapter.getFullPath(folder.path))).isSymbolicLink()) return this.adapter.remove(folder.path);
		for (const child of [...folder.children]) {
			if (child instanceof TFolder) await this.#deleteTree(child);
			else await this.adapter.remove(child.path);
		}
		await this.adapter.rmdir(folder.path, false);
	}

	async trash(file: TAbstractFile, system: boolean) {
		if (!system || !(await this.adapter.trashSystem(file.path))) await this.adapter.trashLocal(file.path);
	}

	async rename(file: TAbstractFile, newPath: string) {
		newPath = normalizePath(newPath);
		if (newPath === file.path) return;
		const existing = this.fileMap[newPath] ?? (this.adapter.insensitive ? this.#lower.get(newPath.toLowerCase()) : undefined);
		if (existing && existing !== file) throw new Error("Destination file already exists!");
		await this.adapter.rename(file.path, newPath);
	}

	async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
		newPath = this.#newPath(newPath, file instanceof TFolder ? "Folder already exists." : "File already exists.");
		await this.adapter.copy(file.path, newPath);
		const copy = this.fileMap[newPath] ?? (file instanceof TFolder ? new TFolder(this, newPath) : await this.#fileAt(newPath));
		return copy as T;
	}

	// Pre-order, children in order.
	static recurseChildren(root: TFolder, cb: (file: TAbstractFile) => any) {
		cb(root);
		if (root instanceof TFolder) for (const child of [...root.children]) Vault.recurseChildren(child as TFolder, cb);
	}

	close() {
		this.adapter.stopWatching();
	}
}
