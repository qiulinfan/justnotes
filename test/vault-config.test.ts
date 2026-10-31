import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Vault } from "../src/api/vault";
import { applyConfigChanges, type ConfigFileName, UNSET, VaultConfigStore } from "../src/api/vault-config";

// Two config files in memory, recording every write.
function memoryStore(files: Partial<Record<ConfigFileName, string>> = {}) {
	const disk: Partial<Record<ConfigFileName, string>> = { ...files };
	const writes: [ConfigFileName, string][] = [];
	const unreadable: ConfigFileName[] = [];
	const store = new VaultConfigStore({
		read: async (name) => disk[name] ?? null,
		write: async (name, text) => {
			writes.push([name, text]);
			disk[name] = text;
		},
		unreadable: (name) => unreadable.push(name),
	});
	return { store, disk, writes, unreadable };
}

describe("applyConfigChanges", () => {
	test("changed keys keep their place, removed keys go, new keys come last", () => {
		const out = applyConfigChanges(
			{ pdfExportSettings: { pageSize: "Letter" }, tabSize: 2, legacyEditor: false },
			new Map<string, unknown>([
				["tabSize", 4],
				["legacyEditor", UNSET],
				["spellcheck", true],
			]),
		);
		expect(JSON.stringify(out)).toBe('{"pdfExportSettings":{"pageSize":"Letter"},"tabSize":4,"spellcheck":true}');
	});
});

describe("VaultConfigStore", () => {
	test("a change is written in Obsidian's format with the file's other keys in place", async () => {
		const { store, disk, writes } = memoryStore({ "app.json": '{\n  "unknownKey": {"a": 1},\n  "showLineNumber": true\n}' });
		await store.reload();
		expect(store.set("showLineNumber", false)).toBe(true);
		await store.save();
		expect(writes.length).toBe(1);
		expect(disk["app.json"]).toBe('{\n  "unknownKey": {\n    "a": 1\n  },\n  "showLineNumber": false\n}');
	});

	test("nothing is written when no value changed, or a value is set to what it reads", async () => {
		const { store, writes } = memoryStore({ "app.json": '{"tabSize": 2}' });
		await store.reload();
		expect(store.set("tabSize", 2)).toBe(false);
		// Unset keys read Obsidian's defaults; setting the default is no change.
		expect(store.set("readableLineLength", true)).toBe(false);
		expect(store.set("userIgnoreFilters", [])).toBe(false);
		expect(store.set("neverSet", UNSET)).toBe(false);
		await store.save();
		expect(writes).toEqual([]);
	});

	test("a missing file is created only for a change, and a key goes to the file Obsidian keeps it in", async () => {
		const { store, disk, writes } = memoryStore({});
		await store.reload();
		store.set("accentColor", "#ff0000");
		store.set("vimMode", true);
		await store.save();
		expect(writes.map(([name]) => name).sort()).toEqual(["app.json", "appearance.json"]);
		expect(disk["appearance.json"]).toBe('{\n  "accentColor": "#ff0000"\n}');
		expect(disk["app.json"]).toBe('{\n  "vimMode": true\n}');
	});

	test("a key stays in the file that already holds it", async () => {
		const { store, disk } = memoryStore({ "app.json": '{"theme": "obsidian"}', "appearance.json": '{"baseFontSize": 16}' });
		await store.reload();
		store.set("theme", "moonstone");
		await store.save();
		expect(disk["app.json"]).toBe('{\n  "theme": "moonstone"\n}');
		expect(disk["appearance.json"]).toBe('{"baseFontSize": 16}');
	});

	test("a file changed outside before the save is merged key by key", async () => {
		const { store, disk } = memoryStore({ "app.json": '{\n  "tabSize": 4,\n  "useTab": true\n}' });
		await store.reload();
		store.set("tabSize", 2);
		// Obsidian (or a git pull) rewrites the file meanwhile.
		disk["app.json"] = '{\n  "tabSize": 8,\n  "useTab": false,\n  "promptDelete": false\n}';
		await store.save();
		expect(JSON.parse(disk["app.json"]!)).toEqual({ tabSize: 2, useTab: false, promptDelete: false });
		expect(store.config).toEqual({ tabSize: 2, useTab: false, promptDelete: false });
		expect(store.takeChanged()).toBe(true);
	});

	test("an outside change is read without writing, and announced once", async () => {
		const { store, disk, writes } = memoryStore({ "appearance.json": '{"theme": "system"}' });
		await store.reload();
		expect(store.takeChanged()).toBe(true);
		expect(store.takeChanged()).toBe(false);
		disk["appearance.json"] = '{"theme": "obsidian"}';
		await store.reload();
		expect(store.config.theme).toBe("obsidian");
		expect(store.takeChanged()).toBe(true);
		await store.save();
		expect(writes).toEqual([]);
	});

	test("a change made after a save that read an outside change keeps both", async () => {
		const { store, disk } = memoryStore({ "app.json": '{"a": 1}' });
		await store.reload();
		store.set("b", 2);
		await store.save();
		disk["app.json"] = '{\n  "a": 5,\n  "b": 2\n}';
		await store.reload();
		store.set("c", 3);
		await store.save();
		expect(JSON.parse(disk["app.json"]!)).toEqual({ a: 5, b: 2, c: 3 });
	});

	test("a file that does not parse is left alone and the change waits until it does", async () => {
		const { store, disk, writes, unreadable } = memoryStore({ "app.json": '{"tabSize": 2}' });
		await store.reload();
		disk["app.json"] = '{"tabSize": 2,';
		store.set("useTab", false);
		await store.save();
		expect(writes).toEqual([]);
		expect(unreadable).toEqual(["app.json"]);
		// The setting still reads the value set in justnotes.
		expect(store.config.useTab).toBe(false);
		expect(store.hasPending).toBe(true);
		disk["app.json"] = '{"tabSize": 3}';
		await store.save();
		expect(JSON.parse(disk["app.json"]!)).toEqual({ tabSize: 3, useTab: false });
	});

	test("removing a key takes it out of its file", async () => {
		const { store, disk } = memoryStore({ "app.json": '{"tabSize": 2, "useTab": false}' });
		await store.reload();
		store.set("tabSize", UNSET);
		await store.save();
		expect(disk["app.json"]).toBe('{\n  "useTab": false\n}');
	});
});

describe("Vault settings files", () => {
	const dirs: { vault: Vault; dir: string }[] = [];
	afterEach(() => {
		for (const { vault, dir } of dirs.splice(0)) {
			vault.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	async function makeVault(files: Record<string, string>) {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-config-")));
		for (const [p, text] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
			fs.writeFileSync(path.join(dir, p), text);
		}
		const vault = new Vault(dir);
		await vault.load();
		dirs.push({ vault, dir });
		return { vault, full: (p: string) => path.join(dir, p) };
	}

	async function until(check: () => boolean, ms = 3000) {
		for (let t = 0; t < ms && !check(); t += 20) await Bun.sleep(20);
		return check();
	}

	test("setConfig saves to app.json; loading and reading write nothing", async () => {
		const original = '{\n  "alwaysUpdateLinks": true,\n  "showLineNumber": true\n}';
		const { vault, full } = await makeVault({ ".obsidian/app.json": original, ".obsidian/appearance.json": '{"theme":"obsidian"}' });
		expect(vault.getConfig("theme")).toBe("obsidian");
		expect(vault.getConfig("tabSize")).toBe(4);
		await vault.saveConfig();
		expect(fs.readFileSync(full(".obsidian/app.json"), "utf8")).toBe(original);
		const changed: unknown[] = [];
		vault.on("config-changed", (k: unknown) => changed.push(k));
		vault.setConfig("showLineNumber", false);
		vault.setConfig("showLineNumber", false);
		expect(changed).toEqual(["showLineNumber"]);
		await vault.saveConfig();
		expect(fs.readFileSync(full(".obsidian/app.json"), "utf8")).toBe('{\n  "alwaysUpdateLinks": true,\n  "showLineNumber": false\n}');
		expect(fs.readFileSync(full(".obsidian/appearance.json"), "utf8")).toBe('{"theme":"obsidian"}');
		expect(fs.existsSync(full(".obsidian/workspace.json"))).toBe(false);
	});

	test("a file written outside is taken in and announced", async () => {
		const { vault, full } = await makeVault({ ".obsidian/appearance.json": '{"theme":"obsidian"}' });
		const changed: unknown[] = [];
		vault.on("config-changed", () => changed.push(vault.getConfig("theme")));
		fs.writeFileSync(full(".obsidian/appearance.json"), '{"theme":"moonstone"}');
		expect(await until(() => changed.length > 0)).toBe(true);
		expect(vault.getConfig("theme")).toBe("moonstone");
		// justnotes' own write is no outside change.
		vault.setConfig("accentColor", "#123456");
		await vault.saveConfig();
		await Bun.sleep(300);
		expect(changed).toEqual(["moonstone", "moonstone"]);
	});
});
