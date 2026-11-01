import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import { Events } from "./events";
import { normalizePath } from "./util";
import { DEFAULT_CONFIG, UNSET, VaultConfigStore } from "./vault-config";

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

// Rewrites each segment of a path in the spelling of the existing entry it
// names regardless of case; `find` maps a lowercased path to that entry's
// path. With `keepName` the last segment stays as given: a rename target.
function respell(path: string, find: (lower: string) => string | undefined, keepName: boolean): string {
	const i = path.lastIndexOf("/");
	const parent = i < 0 ? "" : respell(path.slice(0, i), find, false);
	const joined = join(parent, path.slice(i + 1));
	return keepName ? joined : (find(joined.toLowerCase()) ?? joined);
}

// A watcher-reported deletion waits this long, so a file that an editor or git
// replaces by delete-then-create reads as one modification.
const DELETE_GRACE = 100;

// A write waits this long at most for the reads of its file begun before it:
// a read that hangs (a FIFO, a stalled network mount) must not hold up every
// write in the vault. A read given up on may see the write half done.
const READ_WAIT = 1000;

// Writes through a handle and takes the stat from it before closing: the stat
// is that of these bytes, even when another program writes the file right after.
async function put(full: string, flag: "w" | "a", data: string | Uint8Array, mtime?: number) {
	const handle = await fs.promises.open(full, flag);
	try {
		await handle.writeFile(data);
		if (mtime !== undefined) await handle.utimes(new Date(), new Date(mtime));
		return await handle.stat();
	} finally {
		await handle.close();
	}
}

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
	// The Node modules Obsidian's desktop adapter exposes; plugins read them
	// (terminal's Save as HTML checks adapter.fs before saving).
	fs = fs;
	fsPromises = fs.promises;
	path = nodePath;
	url = nodeUrl;
	#handler: AdapterChange | null = null;
	#queue: Promise<unknown> = Promise.resolve();
	// Per file, the write putting its bytes on disk and the reads under way:
	// a read waits for that write and a write for the reads begun before it
	// (up to READ_WAIT), so no read sees a file half written. A read never
	// waits for writes still queued, as code running inside the queue may
	// read. Writes go in place: a temporary file renamed over a note would
	// give it a new birth time (its stat.ctime) and drop its mode and
	// extended attributes such as Finder tags.
	#writing = new Map<string, Promise<void>>();
	#reading = new Map<string, Set<Promise<unknown>>>();
	// Lowercased path to its key in `files`, for case-insensitive volumes.
	#lower = new Map<string, string>();
	// Folder key ("" for the root) to the keys of the entries directly in it.
	#children = new Map<string, Set<string>>();
	// While an own write is taken in: the stat of its bytes and the ctime asked for.
	#written = new Map<string, { stat: fs.Stats; ctime?: number }>();
	#pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();
	// A file opened in no vault (single-file.ts): the paths that may enter the
	// file table besides the entries already in it. Its folders are never
	// listed, and each folder holding an entry is watched alone, not the tree.
	#scope: Set<string> | null = null;
	#folderWatchers = new Map<string, fs.FSWatcher>();

	constructor(basePath: string) {
		this.basePath = basePath;
	}

	setScope(paths: string[]) {
		this.#scope = new Set(paths.map(key));
	}

	get scoped() {
		return this.#scope !== null;
	}

	// Lets a path into a scoped file table and takes it in when it exists.
	admit(path: string): Promise<void> {
		const norm = key(path);
		if (!this.#scope || !norm || this.files[norm]) return Promise.resolve();
		this.#scope.add(norm);
		return this.#serial(() => this.reconcileFile(norm, norm));
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
		return nodeUrl.pathToFileURL(this.getFullPath(normalizedPath)).href;
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
		const url = nodeUrl.pathToFileURL(full).href;
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

	// On a case-insensitive volume a path names the entry it matches
	// regardless of case, so each segment takes the file table's spelling.
	#respell(norm: string, keepName = false) {
		if (!this.insensitive) return norm;
		const find = (lower: string) => {
			const found = this.#lower.get(lower);
			return found !== undefined && this.files[found] ? found : undefined;
		};
		return respell(norm, find, keepName);
	}

	#add(norm: string, entry: FileEntry) {
		if (this.#scope) this.#watchFolder(parentOf(norm));
		this.files[norm] = entry;
		this.#lower.set(norm.toLowerCase(), norm);
		const parent = parentOf(norm);
		let children = this.#children.get(parent);
		if (!children) this.#children.set(parent, (children = new Set()));
		children.add(norm);
	}

	#drop(norm: string) {
		delete this.files[norm];
		const lower = norm.toLowerCase();
		if (this.#lower.get(lower) === norm) this.#lower.delete(lower);
		const parent = parentOf(norm);
		const children = this.#children.get(parent);
		if (children?.delete(norm) && !children.size) this.#children.delete(parent);
	}

	// The keys of the entries below a folder, at any depth.
	#below(norm: string) {
		const out: string[] = [];
		const walk = (folder: string) => {
			for (const child of this.#children.get(folder) ?? []) {
				out.push(child);
				walk(child);
			}
		};
		walk(norm);
		return out;
	}

	async exists(normalizedPath: string, sensitive?: boolean) {
		const norm = key(normalizedPath);
		try {
			await fs.promises.access(this.getFullPath(norm));
		} catch {
			return false;
		}
		return !sensitive || !this.insensitive || !norm || this.#spelled(this.#realPath(norm));
	}

	// Whether every segment of the path appears spelled exactly so in its folder.
	async #spelled(realPath: string) {
		const parts = realPath.split("/");
		const found = await Promise.all(
			parts.map(async (name, i) => {
				const names = await fs.promises.readdir(this.#abs(parts.slice(0, i).join("/"))).catch(() => [] as string[]);
				const want = name.normalize("NFC");
				return names.some((n) => n.normalize("NFC") === want);
			}),
		);
		return found.every(Boolean);
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
		return this.#readTurn(normalizedPath, (full) => fs.promises.readFile(full, "utf8"));
	}

	readBinary(normalizedPath: string) {
		return this.#readTurn(normalizedPath, async (full) => {
			const b = await fs.promises.readFile(full);
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		});
	}

	// One key per file for the read and write turns: on a case-insensitive
	// volume every spelling of a path names the same file.
	#turnKey(normalizedPath: string) {
		const norm = key(normalizedPath);
		return this.insensitive ? norm.toLowerCase() : norm;
	}

	#readTurn<T>(normalizedPath: string, read: (full: string) => Promise<T>): Promise<T> {
		const turn = this.#turnKey(normalizedPath);
		const start = () => read(this.getFullPath(normalizedPath));
		const writing = this.#writing.get(turn);
		const run = writing ? writing.then(start) : start();
		let reads = this.#reading.get(turn);
		if (!reads) this.#reading.set(turn, (reads = new Set()));
		reads.add(run);
		const done = () => {
			reads.delete(run);
			if (!reads.size && this.#reading.get(turn) === reads) this.#reading.delete(turn);
		};
		run.then(done, done);
		return run;
	}

	// Puts a file's bytes on disk once the reads begun before have finished;
	// reads begun meanwhile wait for it. Runs inside #serial, so writes of
	// one file never overlap.
	async #writeTurn<T>(norm: string, write: () => Promise<T>): Promise<T> {
		const turn = this.#turnKey(norm);
		const begun = [...(this.#reading.get(turn) ?? [])];
		let finish = () => {};
		const writing = new Promise<void>((resolve) => (finish = resolve));
		this.#writing.set(turn, writing);
		try {
			if (begun.length) await this.#awaitReads(turn, begun);
			return await write();
		} finally {
			if (this.#writing.get(turn) === writing) this.#writing.delete(turn);
			finish();
		}
	}

	// Reads still under way after READ_WAIT are given up on, so later writes
	// no longer wait for them. Those reads are still in the file's set, as a
	// set leaves the map only once empty.
	async #awaitReads(turn: string, begun: Promise<unknown>[]) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, READ_WAIT)));
		await Promise.race([Promise.allSettled(begun), late]);
		clearTimeout(timer);
		const reads = this.#reading.get(turn);
		if (!reads) return;
		for (const read of begun) reads.delete(read);
		if (!reads.size) this.#reading.delete(turn);
	}

	// Whether a write is putting the file's bytes on disk at the moment.
	isWriting(normalizedPath: string) {
		return this.#writing.has(this.#turnKey(normalizedPath));
	}

	write(normalizedPath: string, data: string, options?: DataWriteOptions) {
		return this.#mutate(normalizedPath, "w", data, options);
	}

	writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions) {
		return this.#mutate(normalizedPath, "w", new Uint8Array(data), options);
	}

	append(normalizedPath: string, data: string, options?: DataWriteOptions) {
		return this.#mutate(normalizedPath, "a", data, options);
	}

	appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions) {
		return this.#mutate(normalizedPath, "a", new Uint8Array(data), options);
	}

	// Serialized with every other change, so no write lands between the read
	// and the save. An unchanged result is not written.
	process(normalizedPath: string, fn: (data: string) => string, options?: DataWriteOptions) {
		return this.#serial(async () => {
			const norm = this.#respell(key(normalizedPath));
			const full = this.getFullPath(norm);
			const { data, stat } = await this.#writeTurn(norm, async () => {
				const before = await fs.promises.readFile(full, "utf8");
				const after = fn(before);
				return { data: after, stat: after === before ? null : await put(full, "w", after, options?.mtime) };
			});
			if (stat) await this.#reconcileWrite(norm, stat, options?.ctime);
			return data;
		});
	}

	#mutate(normalizedPath: string, flag: "w" | "a", data: string | Uint8Array, options?: DataWriteOptions) {
		return this.#serial(async () => {
			const norm = this.#respell(key(normalizedPath));
			const full = this.getFullPath(norm);
			await fs.promises.mkdir(nodePath.dirname(full), { recursive: true });
			const stat = await this.#writeTurn(norm, () => put(full, flag, data, options?.mtime));
			await this.#reconcileWrite(norm, stat, options?.ctime);
		});
	}

	// Node cannot set a birth time, so a requested ctime is kept in the file table.
	async #reconcileWrite(norm: string, stat: fs.Stats, ctime?: number) {
		this.#written.set(norm, { stat, ctime });
		try {
			await this.reconcileFile(this.#realPath(norm), norm, true);
		} finally {
			this.#written.delete(norm);
		}
	}

	mkdir(normalizedPath: string) {
		return this.#serial(async () => {
			const norm = this.#respell(key(normalizedPath));
			await fs.promises.mkdir(this.getFullPath(norm), { recursive: true });
			await this.reconcileFile(this.#realPath(norm), norm, true);
		});
	}

	remove(normalizedPath: string) {
		return this.#serial(async () => {
			const norm = this.#respell(key(normalizedPath));
			await fs.promises.unlink(this.getFullPath(norm));
			await this.reconcileFile(this.#realPath(norm), norm, true);
		});
	}

	rmdir(normalizedPath: string, recursive: boolean) {
		return this.#serial(async () => {
			const norm = this.#respell(key(normalizedPath));
			const full = this.getFullPath(norm);
			if (recursive) await fs.promises.rm(full, { recursive: true });
			else await fs.promises.rmdir(full);
			await this.reconcileFile(this.#realPath(norm), norm, true);
		});
	}

	// The target keeps its own last segment, so a case-only rename stays one.
	rename(normalizedPath: string, normalizedNewPath: string) {
		return this.#serial(async () => {
			const from = this.#respell(key(normalizedPath));
			const to = this.#respell(key(normalizedNewPath), true);
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
		return this.#serial(async () => {
			const from = this.#respell(key(normalizedPath));
			const to = this.#respell(key(normalizedNewPath));
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
		const norm = this.#respell(key(normalizedPath));
		try {
			await require("electron").shell.trashItem(this.getFullPath(norm));
		} catch {
			return false;
		}
		await this.#serial(() => this.reconcileFile(this.#realPath(norm), norm, true));
		return true;
	}

	// Moves the item into .trash at the vault root under a free name.
	async trashLocal(normalizedPath: string) {
		const norm = this.#respell(key(normalizedPath));
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

	// Runs changes one at a time in call order: watcher events, writes and
	// their reconciliation never interleave, so moving a folder cannot race a
	// write inside it.
	#serial<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(task);
		this.#queue = run.catch(() => {});
		return run;
	}

	// Sets the vault's change handler and starts watching the vault folder.
	async watch(handler: AdapterChange) {
		this.#handler = handler;
		if (this.#scope) this.#watchFolder("");
		else if (!this.watchers[""]) this.#watchDir("", this.basePath);
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

	// A scoped table's folder, watched without its subfolders.
	#watchFolder(norm: string) {
		if (this.#folderWatchers.has(norm)) return;
		try {
			const watcher = fs.watch(this.#abs(this.#realPath(norm)), (_event, filename) => {
				if (filename) this.#onWatch(norm, String(filename));
			});
			watcher.on("error", () => {
				watcher.close();
				this.#folderWatchers.delete(norm);
			});
			this.#folderWatchers.set(norm, watcher);
		} catch (err) {
			console.warn("Vault watcher unavailable", norm, err);
		}
	}

	// Every change is announced as 'raw', hidden paths included; only visible
	// paths and watched hidden folders are reconciled into the file table.
	#onWatch(prefix: string, filename: string) {
		const realPath = join(this.#realPath(prefix), filename.split(nodePath.sep).join("/"));
		const norm = key(realPath);
		this.trigger("raw", norm);
		if (this.#scope && !this.#scope.has(norm) && !this.files[norm]) return;
		if (isHidden(norm) && !Object.keys(this.watchers).some((w) => w && (norm === w || norm.startsWith(`${w}/`)))) return;
		this.#serial(() => this.reconcileFile(realPath, norm)).catch((err) => console.error("Vault: could not reconcile", norm, err));
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
		if (this.#scope) {
			for (const p of this.#scope) await this.reconcileFile(p, p);
			return;
		}
		await this.#list(path, false);
	}

	async #list(realPath: string, fresh: boolean) {
		if (this.#scope) return;
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
			for (const p of [...(this.#children.get(norm) ?? [])]) {
				const entry = this.files[p];
				if (entry && !present.has(p)) await this.reconcileDeletion(entry.realpath, p, true);
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

	// On a case-insensitive volume a stat also finds a path under another
	// case, such as a name the watcher reports after a case-only rename of the
	// file or of a folder above it, so every segment must be spelled exactly.
	async #present(realPath: string) {
		try {
			await fs.promises.stat(this.#abs(realPath));
		} catch (err) {
			if (missing(err)) return false;
			throw err;
		}
		return !this.insensitive || this.#spelled(realPath);
	}

	async reconcileFileInternal(realPath: string, normalizedPath: string) {
		if (!normalizedPath) return;
		// An own write reports 'modified' even when the stat looks unchanged,
		// but only for an entry that existed before it. It records the stat of
		// its own bytes: when another program has written the file since, the
		// stat on disk differs from it, and the watcher reports that write too.
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
		const bytes = written?.stat ?? s;
		if (!entry) {
			const stat = { ctime: written?.ctime ?? birth(bytes), mtime: bytes.mtimeMs, size: bytes.size };
			this.#add(normalizedPath, { type: "file", realpath: realPath, ...stat });
			this.trigger("file-created", normalizedPath, undefined, { ...stat });
		} else if ((written && entry === before) || entry.mtime !== s.mtimeMs || entry.size !== s.size) {
			const stat = { ctime: written?.ctime ?? entry.ctime, mtime: bytes.mtimeMs, size: bytes.size };
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
			s = await fs.promises.lstat(full);
			if (s.isSymbolicLink()) {
				target = await fs.promises.realpath(full);
				if (await this.#cyclic(normalizedPath, target)) return;
				s = await fs.promises.stat(full);
			}
		} catch (err) {
			if (missing(err)) return;
			throw err;
		}
		if (!s.isDirectory() || this.files[normalizedPath]) return;
		this.#add(normalizedPath, { type: "folder", realpath: realPath, ctime: birth(s), mtime: s.mtimeMs, size: 0 });
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
		const doomed = this.#below(normalizedPath).sort((a, b) => b.length - a.length);
		doomed.push(normalizedPath);
		for (const p of doomed) {
			const entry = this.files[p];
			if (!entry) continue;
			this.#drop(p);
			this.#cancelDelete(p);
			if (p && this.watchers[p]) this.stopWatchPath(p);
			this.trigger(entry.type === "folder" ? "folder-removed" : "file-removed", p);
		}
	}

	#deleteLater(realPath: string, normalizedPath: string) {
		if (this.#pendingDeletes.has(normalizedPath)) return;
		const timer = setTimeout(() => {
			this.#pendingDeletes.delete(normalizedPath);
			this.#serial(async () => {
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
		for (const p of [from, ...this.#below(from)]) {
			const entry = this.files[p];
			this.#drop(p);
			entry.realpath = toReal + entry.realpath.slice(fromReal.length);
			this.#add(to + p.slice(from.length), entry);
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
		for (const watcher of this.#folderWatchers.values()) watcher.close();
		this.#folderWatchers.clear();
		for (const timer of this.#pendingDeletes.values()) clearTimeout(timer);
		this.#pendingDeletes.clear();
	}
}

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
	// app.json and appearance.json (vault-config.ts).
	#settings: VaultConfigStore;
	#configTimer: ReturnType<typeof setTimeout> | null = null;
	#saveTimer: ReturnType<typeof setTimeout> | null = null;
	#loading = false;

	// The file name of a file opened in no vault (single-file.ts), whose folder
	// is the vault's root; null for a vault.
	readonly singleFile: string | null;

	constructor(basePath: string, singleFile: string | null = null) {
		super();
		this.singleFile = singleFile;
		this.adapter = new FileSystemAdapter(basePath);
		if (singleFile) this.adapter.setScope([singleFile]);
		this.root = new TFolder(this, "/");
		this.fileMap["/"] = this.root;
		this.#lower.set("/", this.root);
		this.#settings = new VaultConfigStore({
			read: async (name) => {
				try {
					return await this.adapter.read(`${this.configDir}/${name}`);
				} catch {
					return null;
				}
			},
			// A file's window keeps settings changes in memory: its folder is no
			// vault and gets no config folder.
			write: async (name, text) => {
				if (!singleFile) await this.adapter.write(`${this.configDir}/${name}`, text);
			},
			unreadable: (name) => this.trigger("config-unreadable", name),
		});
	}

	// Startup indexing does not fire 'create': no plugin is loaded yet, and the
	// metadata cache indexes every note in its own initial pass.
	async load() {
		await this.loadConfig();
		this.adapter.insensitive = await detectInsensitive(this.adapter.basePath);
		this.#loading = true;
		try {
			await this.adapter.watch(this.#onChange);
			await this.adapter.listRecursive("");
		} finally {
			this.#loading = false;
		}
	}

	// Reads app.json and appearance.json (boot reads them before the scan).
	async loadConfig() {
		await this.#settings.reload();
		this.config = this.#settings.config;
		this.#settings.takeChanged();
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
			await this.#settings.reload();
			this.#announceConfig();
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

	// Sets a setting and saves it to app.json or appearance.json, as Obsidian
	// does; undefined removes it. A value the setting already has changes
	// nothing and writes nothing.
	setConfig(key: string, value: any) {
		if (!this.#settings.set(key, value === undefined ? UNSET : value)) return;
		this.config = this.#settings.config;
		this.trigger("config-changed", key);
		if (this.#saveTimer) clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => void this.saveConfig(), 300);
	}

	// Writes the settings changed since the last save (the quit flush waits
	// for it). A file changed on disk meanwhile is merged key by key.
	async saveConfig() {
		if (this.#saveTimer) clearTimeout(this.#saveTimer);
		this.#saveTimer = null;
		try {
			await this.#settings.save();
		} catch (err) {
			console.error("Could not save the vault's settings", err);
		}
		this.#announceConfig();
	}

	// Tells listeners when reading or saving took in a change from disk.
	#announceConfig() {
		this.config = this.#settings.config;
		if (this.#settings.takeChanged()) this.trigger("config-changed");
	}

	getAbstractFileByPath(path: string) {
		return this.fileMap[normalizePath(path)] ?? null;
	}

	getAbstractFileByPathInsensitive(path: string) {
		const p = normalizePath(path);
		return this.fileMap[p] ?? this.#lower.get(p.toLowerCase()) ?? null;
	}

	// justnotes' own: the path as the file system spells it, on a
	// case-insensitive volume through the existing folders and file it names
	// in another case, as creating or writing there would.
	getDiskPath(path: string) {
		return this.#respell(normalizePath(path));
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
		const at = (suffix: string) => this.#respell(normalizePath(`${path}${suffix}${ext}`), true);
		let candidate = at("");
		for (let i = 1; this.#taken(candidate); i++) candidate = at(` ${i}`);
		return candidate;
	}

	#taken(path: string) {
		return !!this.fileMap[path] || (this.adapter.insensitive && this.#lower.has(path.toLowerCase()));
	}

	// On a case-insensitive volume a path lies in the existing folders it
	// names in another case, as the file system puts it there.
	#respell(path: string, keepName = false) {
		if (!this.adapter.insensitive || path === "/") return path;
		return respell(path, (lower) => this.#lower.get(lower)?.path, keepName);
	}

	// Hidden paths and files the watcher has not reported yet are not in the
	// index, so the disk decides too: creating never replaces what is there.
	async #newPath(path: string, message: string) {
		path = this.#respell(normalizePath(path));
		if (this.#taken(path) || (await this.adapter.exists(path))) throw new Error(message);
		return path;
	}

	async read(file: TFile) {
		const { mtime, size } = file.stat;
		const text = await this.adapter.read(file.path);
		if (file.stat.mtime === mtime && file.stat.size === size) this.#remember(file, text);
		return text;
	}

	// While a write is putting the file on disk, the text comes from disk once
	// it is done.
	async cachedRead(file: TFile) {
		const hit = this.#contents.get(file.path);
		if (hit && hit.mtime === file.stat.mtime && hit.size === file.stat.size && !this.adapter.isWriting(file.path)) return hit.text;
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
		path = await this.#newPath(path, "File already exists.");
		await this.adapter.write(path, data, options);
		const file = await this.#fileAt(path);
		this.#remember(file, data);
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer, options?: DataWriteOptions) {
		path = await this.#newPath(path, "File already exists.");
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
		path = await this.#newPath(path, "Folder already exists.");
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
		newPath = this.#respell(normalizePath(newPath), true);
		if (newPath === file.path) return;
		const existing = this.fileMap[newPath] ?? (this.adapter.insensitive ? this.#lower.get(newPath.toLowerCase()) : undefined);
		if (existing && existing !== file) throw new Error("Destination file already exists!");
		await this.adapter.rename(file.path, newPath);
	}

	async copy<T extends TAbstractFile>(file: T, newPath: string): Promise<T> {
		newPath = await this.#newPath(newPath, file instanceof TFolder ? "Folder already exists." : "File already exists.");
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
		if (this.#saveTimer) clearTimeout(this.#saveTimer);
		if (this.#configTimer) clearTimeout(this.#configTimer);
		this.adapter.stopWatching();
	}
}
