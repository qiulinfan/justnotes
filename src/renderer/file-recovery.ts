import type { CorePluginHost } from "../api/internal-plugins";
import type { App } from "../api/app";
import { Modal } from "../api/ui/modal";
import { Notice } from "../api/ui/notice";
import { moment } from "../api/util";
import { type TAbstractFile, TFile } from "../api/vault";
import { matchLines } from "../api/view";

// file-recovery.json, as Obsidian's settings write it.
interface RecoveryOptions {
	intervalMinutes?: number;
	keepDays?: number;
}

export interface Snapshot {
	id?: number;
	path: string;
	ts: number;
	data: string;
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RECOVERABLE = new Set(["md", "canvas"]);

// When a note whose last snapshot is `last` should be snapshotted, holding
// `data` at `now`: never when the text is the snapshot's, at once when the
// interval has passed (or there is none), else once it passes.
export function snapshotDue(last: { ts: number; data: string } | null, data: string, now: number, interval: number): "skip" | "now" | number {
	if (last?.data === data) return "skip";
	if (!last || now - last.ts >= interval) return "now";
	return last.ts + interval;
}

export interface DiffLine {
	type: "same" | "added" | "removed";
	text: string;
}

// The lines of `after` against `before`: kept, added and removed, in order,
// a changed line as its removal then its addition.
export function lineDiff(before: string, after: string): DiffLine[] {
	const a = before.split("\n");
	const b = after.split("\n");
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	for (const [x, y] of [...matchLines(a, b), [a.length, b.length] as [number, number]]) {
		while (i < x) out.push({ type: "removed", text: a[i++] });
		while (j < y) out.push({ type: "added", text: b[j++] });
		if (x < a.length) out.push({ type: "same", text: a[x] });
		i = x + 1;
		j = y + 1;
	}
	return out;
}

const request = <T>(req: IDBRequest<T>) =>
	new Promise<T>((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});

// Snapshots live in the profile's IndexedDB, outside the vault, one database
// per vault.
export class SnapshotStore {
	#db: Promise<IDBDatabase>;

	constructor(name: string) {
		const open = indexedDB.open(name, 1);
		open.onupgradeneeded = () => {
			const store = open.result.createObjectStore("snapshots", { keyPath: "id", autoIncrement: true });
			store.createIndex("path", "path");
			store.createIndex("ts", "ts");
		};
		this.#db = request(open);
	}

	async #store(mode: IDBTransactionMode) {
		return (await this.#db).transaction("snapshots", mode).objectStore("snapshots");
	}

	async add(snapshot: Snapshot) {
		await request((await this.#store("readwrite")).add(snapshot));
	}

	// Newest first.
	async list(path: string): Promise<Snapshot[]> {
		const all = await request((await this.#store("readonly")).index("path").getAll(path));
		return (all as Snapshot[]).sort((a, b) => b.ts - a.ts);
	}

	// Every path with snapshots and the time of its newest one.
	async paths(): Promise<Map<string, number>> {
		const store = await this.#store("readonly");
		const paths = new Map<string, number>();
		await new Promise<void>((resolve, reject) => {
			const cursor = store.openCursor();
			cursor.onerror = () => reject(cursor.error);
			cursor.onsuccess = () => {
				const c = cursor.result;
				if (!c) return resolve();
				const { path, ts } = c.value as Snapshot;
				paths.set(path, Math.max(paths.get(path) ?? 0, ts));
				c.continue();
			};
		});
		return paths;
	}

	async prune(before: number) {
		const store = await this.#store("readwrite");
		const keys = await request(store.index("ts").getAllKeys(IDBKeyRange.upperBound(before, true)));
		for (const key of keys) store.delete(key);
	}

	async rename(from: string, to: string) {
		const store = await this.#store("readwrite");
		for (const snapshot of (await request(store.index("path").getAll(from))) as Snapshot[]) store.put({ ...snapshot, path: to });
	}
}

class FileRecovery {
	app: App;
	store: SnapshotStore;
	#last = new Map<string, { ts: number; data: string } | null>();
	#timers = new Map<string, number>();

	constructor(app: App) {
		this.app = app;
		this.store = new SnapshotStore(`${app.appId}-file-recovery`);
	}

	get options(): RecoveryOptions {
		return this.app.internalPlugins.getPluginById("file-recovery")?.instance.options ?? {};
	}

	get interval() {
		const minutes = Number(this.options.intervalMinutes);
		return (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * MINUTE;
	}

	get keep() {
		const days = Number(this.options.keepDays);
		return (Number.isFinite(days) && days > 0 ? days : 7) * DAY;
	}

	install(host: CorePluginHost) {
		const { vault, workspace } = this.app;
		const watch = (file: TAbstractFile | null) => {
			if (file instanceof TFile && RECOVERABLE.has(file.extension)) this.schedule(file);
		};
		host.registerEvent(vault.on("modify", watch));
		// The text as it was opened, before any edit.
		host.registerEvent(workspace.on("file-open", watch));
		host.registerEvent(
			vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (!(file instanceof TFile)) return;
				this.#last.delete(oldPath);
				this.store.rename(oldPath, file.path).catch((err) => console.error(err));
			}),
		);
		const prune = () => this.store.prune(Date.now() - this.keep).catch((err) => console.error(err));
		prune();
		host.registerInterval(window.setInterval(prune, 60 * MINUTE));
		host.register(() => {
			for (const timer of this.#timers.values()) clearTimeout(timer);
			this.#timers.clear();
		});
	}

	async #lastOf(path: string) {
		if (!this.#last.has(path)) this.#last.set(path, (await this.store.list(path))[0] ?? null);
		return this.#last.get(path) ?? null;
	}

	async schedule(file: TFile) {
		if (this.#timers.has(file.path)) return;
		try {
			const [last, data] = await Promise.all([this.#lastOf(file.path), this.app.vault.cachedRead(file)]);
			const due = snapshotDue(last, data, Date.now(), this.interval);
			if (due === "now") await this.save(file.path, data);
			else if (due !== "skip" && !this.#timers.has(file.path)) {
				const path = file.path;
				this.#timers.set(
					path,
					window.setTimeout(() => {
						this.#timers.delete(path);
						const now = this.app.vault.getFileByPath(path);
						if (now) this.schedule(now);
					}, due - Date.now()),
				);
			}
		} catch (err) {
			console.error(err);
		}
	}

	async save(path: string, data: string) {
		const snapshot = { path, ts: Date.now(), data };
		this.#last.set(path, snapshot);
		await this.store.add(snapshot);
	}

	// Writes a snapshot back, keeping the current text as a snapshot first.
	async restore(snapshot: Snapshot) {
		const { vault } = this.app;
		const file = vault.getFileByPath(snapshot.path);
		if (file) {
			const current = await vault.read(file);
			if (current === snapshot.data) return;
			if (current !== this.#last.get(file.path)?.data) await this.save(file.path, current);
			await vault.modify(file, snapshot.data);
		} else {
			const folder = snapshot.path.split("/").slice(0, -1).join("/");
			if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder);
			await vault.create(snapshot.path, snapshot.data);
		}
	}
}

const when = (ts: number) => moment(ts).format("YYYY-MM-DD HH:mm:ss");

// Browses a note's snapshots: the notes with snapshots (deleted ones too),
// a note's snapshots newest first, and a snapshot's text or its changes
// against the note as it is now, to copy or restore.
class FileRecoveryModal extends Modal {
	#recovery: FileRecovery;
	#paths = new Map<string, number>();
	#path: string | null;
	#snapshot: Snapshot | null = null;
	#showChanges = false;
	#filesEl!: HTMLElement;
	#snapshotsEl!: HTMLElement;
	#previewEl!: HTMLElement;
	#toolbarEl!: HTMLElement;
	#filter = "";

	constructor(app: App, recovery: FileRecovery, path: string | null) {
		super(app);
		this.#recovery = recovery;
		this.#path = path;
		this.modalEl.addClass("mod-file-recovery");
		this.setTitle("File recovery");
	}

	async onOpen() {
		const body = this.contentEl.createDiv("file-recovery-body");
		const files = body.createDiv("file-recovery-files");
		const search = files.createDiv("search-input-container").createEl("input", { type: "search", placeholder: "Search files..." });
		search.addEventListener("input", () => {
			this.#filter = search.value.trim().toLowerCase();
			this.#renderFiles();
		});
		this.#filesEl = files.createDiv("file-recovery-list");
		this.#snapshotsEl = body.createDiv("file-recovery-snapshots file-recovery-list");
		const right = body.createDiv("file-recovery-preview");
		this.#toolbarEl = right.createDiv("file-recovery-toolbar");
		this.#previewEl = right.createDiv("file-recovery-text");
		this.#paths = await this.#recovery.store.paths();
		if (this.#path && !this.#paths.has(this.#path)) this.#path = null;
		this.#renderFiles();
		await this.#selectFile(this.#path);
		search.focus();
	}

	#renderFiles() {
		this.#filesEl.empty();
		const paths = [...this.#paths].filter(([p]) => p.toLowerCase().includes(this.#filter)).sort((a, b) => b[1] - a[1]);
		if (!paths.length) this.#filesEl.createDiv({ cls: "file-recovery-empty", text: "No snapshots yet." });
		for (const [path] of paths) {
			const row = this.#filesEl.createDiv({ cls: "file-recovery-item", text: path.replace(/\.md$/, "") });
			row.setAttr("aria-label", path);
			if (!this.app.vault.getFileByPath(path)) row.addClass("is-deleted");
			row.toggleClass("is-selected", path === this.#path);
			row.addEventListener("click", () => this.#selectFile(path));
		}
	}

	async #selectFile(path: string | null) {
		this.#path = path;
		this.#renderFiles();
		this.#snapshotsEl.empty();
		const snapshots = path ? await this.#recovery.store.list(path) : [];
		if (path !== this.#path) return;
		for (const snapshot of snapshots) {
			const row = this.#snapshotsEl.createDiv({ cls: "file-recovery-item", text: when(snapshot.ts) });
			row.addEventListener("click", () => {
				for (const el of Array.from(this.#snapshotsEl.children)) el.removeClass("is-selected");
				row.addClass("is-selected");
				this.#selectSnapshot(snapshot);
			});
		}
		(this.#snapshotsEl.firstElementChild as HTMLElement | null)?.click();
		if (!snapshots.length) await this.#selectSnapshot(null);
	}

	async #selectSnapshot(snapshot: Snapshot | null) {
		this.#snapshot = snapshot;
		this.#toolbarEl.empty();
		this.#previewEl.empty();
		if (!snapshot) {
			this.#previewEl.createDiv({ cls: "file-recovery-empty", text: this.#path ? "No snapshots." : "Pick a file." });
			return;
		}
		const file = this.app.vault.getFileByPath(snapshot.path);
		const label = this.#toolbarEl.createEl("label", { cls: "file-recovery-toggle" });
		const toggle = label.createEl("input", { type: "checkbox" });
		toggle.checked = this.#showChanges;
		toggle.disabled = !file;
		label.appendText(file ? "Show changes from the file now" : "Show changes (the file is gone)");
		toggle.addEventListener("change", () => {
			this.#showChanges = toggle.checked;
			this.#selectSnapshot(snapshot);
		});
		this.#toolbarEl.createEl("button", { text: "Copy" }).addEventListener("click", async () => {
			await navigator.clipboard.writeText(snapshot.data);
			new Notice("Copied the snapshot.");
		});
		const restore = this.#toolbarEl.createEl("button", { text: "Restore", cls: "mod-cta" });
		restore.addEventListener("click", async () => {
			try {
				await this.#recovery.restore(snapshot);
				new Notice(`Restored ${snapshot.path} to ${when(snapshot.ts)}.`);
				this.close();
			} catch (err) {
				new Notice(`Could not restore: ${err instanceof Error ? err.message : err}`);
			}
		});
		const pre = this.#previewEl.createEl("pre");
		if (!this.#showChanges || !file) {
			pre.setText(snapshot.data);
			return;
		}
		// What restoring would change: the note now against the snapshot.
		const current = await this.app.vault.read(file);
		if (snapshot !== this.#snapshot) return;
		const diff = lineDiff(current, snapshot.data);
		if (!diff.some((l) => l.type !== "same")) pre.createDiv({ cls: "file-recovery-empty", text: "Same as the file now." });
		for (const line of diff) pre.createDiv({ cls: `file-recovery-line mod-${line.type}`, text: line.text || " " });
	}
}

// Obsidian's File recovery: snapshots of edited notes kept outside the vault
// (file-recovery.json's intervalMinutes and keepDays), and a modal to browse
// and restore them.
export function installFileRecovery(app: App, host: CorePluginHost) {
	const recovery = new FileRecovery(app);
	recovery.install(host);
	host.addCommand({
		id: "file-recovery:open",
		name: "File recovery: Open saved snapshots",
		callback: () => new FileRecoveryModal(app, recovery, app.workspace.getActiveFile()?.path ?? null).open(),
	});
}
