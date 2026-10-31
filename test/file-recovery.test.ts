import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "../src/api/app";
import { Component, Events } from "../src/api/events";
import type { CorePluginHost } from "../src/api/internal-plugins";
import { Vault } from "../src/api/vault";
import { FileRecovery, type RecoveryStore, type Snapshot } from "../src/renderer/file-recovery";

// IndexedDB is the renderer's; tests keep snapshots in an array.
class MemoryStore implements RecoveryStore {
	snapshots: Snapshot[] = [];
	async add(snapshot: Snapshot) {
		this.snapshots.push({ ...snapshot });
	}
	async list(p: string) {
		return this.snapshots.filter((s) => s.path === p).sort((a, b) => b.ts - a.ts);
	}
	async paths() {
		return new Map(this.snapshots.map((s) => [s.path, s.ts]));
	}
	async prune() {}
	async rename(from: string, to: string) {
		for (const s of this.snapshots) if (s.path === from) s.path = to;
	}
	texts(p: string) {
		return this.snapshots.filter((s) => s.path === p).map((s) => s.data);
	}
}

// FileRecovery's timers are the renderer window's.
const hadWindow = "window" in globalThis;
beforeAll(() => {
	if (!hadWindow) (globalThis as { window?: unknown }).window = globalThis;
});
afterAll(() => {
	if (!hadWindow) delete (globalThis as { window?: unknown }).window;
});

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function setup(files: Record<string, string>) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-recovery-")));
	for (const [p, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), text);
	const vault = new Vault(dir);
	await vault.load();
	const workspace = new Events();
	// An interval of 150 ms.
	const options = { intervalMinutes: 0.0025 };
	const app = { appId: "test", vault, workspace, internalPlugins: { getPluginById: () => ({ instance: { options } }) } } as unknown as App;
	const store = new MemoryStore();
	const recovery = new FileRecovery(app, store);
	const host = new Component();
	host.load();
	recovery.install(host as CorePluginHost);
	cleanups.push(() => {
		host.unload();
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return { vault, workspace, store };
}

async function until(check: () => boolean, ms = 2000) {
	for (let t = 0; t < ms && !check(); t += 10) await Bun.sleep(10);
	return check();
}

describe("file recovery snapshots", () => {
	test("an edit waiting for the interval is snapshotted under the note's new name after a rename", async () => {
		const { vault, workspace, store } = await setup({ "a.md": "one" });
		workspace.trigger("file-open", vault.getFileByPath("a.md"));
		expect(await until(() => store.snapshots.length === 1)).toBe(true);
		await vault.modify(vault.getFileByPath("a.md")!, "two");
		await Bun.sleep(20);
		await vault.rename(vault.getFileByPath("a.md")!, "b.md");
		expect(await until(() => store.texts("b.md").includes("two"))).toBe(true);
		expect(store.texts("b.md").sort()).toEqual(["one", "two"]);
		expect(store.texts("a.md")).toEqual([]);
	});

	test("deleting a note with an edit waiting for the interval keeps its last text", async () => {
		const { vault, workspace, store } = await setup({ "a.md": "one" });
		workspace.trigger("file-open", vault.getFileByPath("a.md"));
		expect(await until(() => store.snapshots.length === 1)).toBe(true);
		await vault.modify(vault.getFileByPath("a.md")!, "two");
		await Bun.sleep(20);
		await vault.modify(vault.getFileByPath("a.md")!, "three");
		await Bun.sleep(20);
		await vault.delete(vault.getFileByPath("a.md")!);
		expect(await until(() => store.texts("a.md").includes("three"))).toBe(true);
		expect(store.texts("a.md")).toEqual(["one", "three"]);
	});
});
