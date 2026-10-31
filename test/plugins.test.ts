import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { App } from "../src/api/app";
import { installLanguageExtensions } from "../src/api/dom";
import { applyOverlay, Plugins } from "../src/api/plugins";

installLanguageExtensions();

// justnotes never writes community-plugins.json; the Community plugins toggles
// persist an overlay that applies on top of it at startup.
describe("enabled plugins", () => {
	test("the user's choices apply over community-plugins.json, which keeps its order", () => {
		expect(applyOverlay(["a", "b", "c"], { enabled: ["d", "a"], disabled: ["b"] })).toEqual(["a", "c", "d"]);
	});
});

// A plugin whose instances count themselves while loaded, read from disk with
// a delay, as the vault adapter reads main.js.
const PLUGIN = `module.exports = class {
	constructor(app, manifest) { this.manifest = manifest; }
	async load() { globalThis.__liveDemo = (globalThis.__liveDemo ?? 0) + 1; this.loaded = true; }
	unload() { if (this.loaded) globalThis.__liveDemo--; this.loaded = false; }
	onUserEnable() {}
};`;

function pluginHost(code = PLUGIN) {
	const saved: { overlay?: unknown } = {};
	const files: Record<string, string> = {
		".obsidian/plugins/demo/manifest.json": JSON.stringify({ id: "demo", name: "Demo", version: "1.0.0", minAppVersion: "", author: "", description: "" }),
		".obsidian/plugins/demo/main.js": code,
	};
	const app = {
		vault: {
			configDir: ".obsidian",
			adapter: {
				read: async (path: string) => {
					await Bun.sleep(5);
					if (!(path in files)) throw new Error(`ENOENT ${path}`);
					return files[path];
				},
				list: async () => ({ files: [], folders: [".obsidian/plugins/demo"] }),
			},
		},
		loadLocalStorage: () => null,
		saveLocalStorage: (_key: string, value: unknown) => (saved.overlay = structuredClone(value)),
	} as unknown as App;
	const plugins = new Plugins(app);
	(app as { plugins?: Plugins }).plugins = plugins;
	return { plugins, saved };
}

// The Community plugins toggles and `justnotes plugin:enable|disable` call
// these without waiting for each other. Two loads at once once left a second
// instance running with nothing to unload it, and a toggle flipped on, off,
// on, off quickly ended loaded and saved as enabled.
describe("turning a plugin on and off", () => {
	const live = () => (globalThis as { __liveDemo?: number }).__liveDemo ?? 0;
	beforeEach(() => {
		(globalThis as { window?: unknown }).window = { eval: (code: string) => (0, eval)(code) };
		(globalThis as { __liveDemo?: number }).__liveDemo = 0;
	});
	afterEach(() => {
		delete (globalThis as { window?: unknown }).window;
		delete (globalThis as { __liveDemo?: number }).__liveDemo;
	});

	test("two enables at once load one instance, which disabling unloads", async () => {
		const { plugins } = pluginHost();
		await plugins.loadManifests();
		expect(await Promise.all([plugins.enablePlugin("demo"), plugins.enablePlugin("demo")])).toEqual([true, true]);
		expect(live()).toBe(1);
		await plugins.disablePlugin("demo");
		expect(live()).toBe(0);
	});

	test("quick toggles end in the last one's state, loaded and saved", async () => {
		const { plugins, saved } = pluginHost();
		await plugins.loadManifests();
		await Promise.all([plugins.enablePluginAndSave("demo"), plugins.disablePluginAndSave("demo"), plugins.enablePluginAndSave("demo"), plugins.disablePluginAndSave("demo")]);
		expect([live(), !!plugins.getPlugin("demo"), saved.overlay]).toEqual([0, false, { enabled: [], disabled: ["demo"] }]);
		await Promise.all([plugins.disablePluginAndSave("demo"), plugins.enablePluginAndSave("demo")]);
		expect([live(), !!plugins.getPlugin("demo"), saved.overlay]).toEqual([1, true, { enabled: ["demo"], disabled: [] }]);
	});

	// Waiting in line would wait for its own load to end.
	test("a plugin that turns itself off while loading ends off, without waiting for itself", async () => {
		const selfDisabling = "module.exports = class { constructor(app, m) { this.app = app; this.manifest = m; } async load() { await this.app.plugins.disablePlugin(this.manifest.id); } unload() {} };";
		const { plugins } = pluginHost(selfDisabling);
		await plugins.loadManifests();
		expect(await Promise.race([plugins.enablePlugin("demo"), Bun.sleep(1000).then(() => "stuck")])).toBe(false);
		expect(plugins.getPlugin("demo")).toBeNull();
	});
});

// While justnotes' own Terminal core plugin is on, the community plugin
// `terminal` it replaces is not loaded (both would register a terminal and
// its commands); turned off, the community plugin loads again.
describe("community plugins replaced by a core plugin", () => {
	const PLAIN = "module.exports = class { constructor(app, m) { this.manifest = m; } async load() {} unload() {} };";

	function replacedHost() {
		const files: Record<string, string> = {
			".obsidian/community-plugins.json": JSON.stringify(["terminal"]),
			".obsidian/plugins/terminal/manifest.json": JSON.stringify({ id: "terminal", name: "Terminal", version: "3.29.0", minAppVersion: "", author: "", description: "" }),
			".obsidian/plugins/terminal/main.js": PLAIN,
		};
		const core = { enabled: true };
		const app = {
			vault: {
				configDir: ".obsidian",
				adapter: {
					read: async (path: string) => {
						if (!(path in files)) throw new Error(`ENOENT ${path}`);
						return files[path];
					},
					list: async () => ({ files: [], folders: [".obsidian/plugins/terminal"] }),
				},
			},
			internalPlugins: { getPluginById: (id: string) => (id === "terminal" ? core : null) },
			loadLocalStorage: () => null,
			saveLocalStorage: () => {},
		} as unknown as App;
		const plugins = new Plugins(app);
		(app as { plugins?: Plugins }).plugins = plugins;
		return { plugins, core };
	}

	beforeEach(() => {
		(globalThis as { window?: unknown }).window = { eval: (code: string) => (0, eval)(code) };
	});
	afterEach(() => {
		delete (globalThis as { window?: unknown }).window;
	});

	test("enabled in community-plugins.json, it stays unloaded while the core plugin is on, and loads when it goes off", async () => {
		const { plugins, core } = replacedHost();
		await plugins.initialize();
		expect([plugins.getPlugin("terminal"), plugins.replacedBy("terminal")]).toEqual([null, "terminal"]);
		core.enabled = false;
		plugins.coreReplacementStopped("terminal");
		await Bun.sleep(20);
		expect(plugins.getPlugin("terminal")).not.toBeNull();
		core.enabled = true;
		await plugins.coreReplacementStarted("terminal");
		expect(plugins.getPlugin("terminal")).toBeNull();
	});
});
