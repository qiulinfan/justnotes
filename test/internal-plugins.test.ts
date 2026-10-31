import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { InternalPlugins, parseCoreConfig } from "../src/api/internal-plugins";
import { Commands } from "../src/api/keymap";

installLanguageExtensions();

function appWithConfig(files: Record<string, unknown>, storage: Record<string, unknown> = {}) {
	const app: any = {
		loadLocalStorage: (key: string) => storage[key] ?? null,
		saveLocalStorage: (key: string, value: unknown) => (storage[key] = JSON.parse(JSON.stringify(value))),
		hotkeyManager: { addDefaultHotkeys() {}, removeDefaultHotkeys() {} },
		vault: {
			configDir: ".obsidian",
			adapter: {
				read: async (path: string) => {
					if (!(path in files)) throw new Error(`ENOENT: ${path}`);
					return JSON.stringify(files[path]);
				},
			},
		},
	};
	app.commands = new Commands(app);
	return app;
}

describe("core-plugins.json", () => {
	test("both the object form and the older array form give the enabled ids", () => {
		expect(parseCoreConfig({ "daily-notes": true, bookmarks: false })).toEqual({ "daily-notes": true, bookmarks: false });
		expect(parseCoreConfig(["templates", "switcher"])).toEqual({ templates: true, switcher: true });
	});

	test("without the file the defaults apply: Slides stays off, as in Obsidian", () => {
		const defaults = parseCoreConfig(null);
		expect(defaults.outline).toBe(true);
		expect(defaults.slides).toBeUndefined();
		expect(parseCoreConfig({ slides: true }).slides).toBe(true);
	});
});

describe("app.internalPlugins", () => {
	test("templates exposes templates.json as its options, as QuickAdd reads them", async () => {
		const internal = new InternalPlugins(
			appWithConfig({ ".obsidian/core-plugins.json": { templates: true }, ".obsidian/templates.json": { folder: "Templates" } }),
		);
		await internal.initialize();
		expect(internal.plugins.templates.instance.options.folder).toBe("Templates");
		expect(internal.getEnabledPluginById("templates")).toBe(internal.plugins.templates.instance);
	});

	test("a core plugin justnotes does not implement stays disabled even when the vault enables it", async () => {
		// The quick switcher exists in justnotes as a command, but its instance has
		// none of Obsidian's members.
		const internal = new InternalPlugins(appWithConfig({ ".obsidian/core-plugins.json": { "page-preview": true, switcher: true } }));
		await internal.initialize();
		expect(internal.getEnabledPluginById("page-preview")).toBeNull();
		expect(internal.getPluginById("switcher")?.enabled).toBe(false);
	});

	test("a core plugin the vault disables is reported disabled", async () => {
		const internal = new InternalPlugins(appWithConfig({ ".obsidian/core-plugins.json": { "daily-notes": false } }));
		await internal.initialize();
		expect(internal.getEnabledPluginById("daily-notes")).toBeNull();
		expect(internal.getPluginById("daily-notes")).not.toBeNull();
	});
});

// The Core plugins settings: a toggle takes effect at once and is kept by
// justnotes over core-plugins.json, which is never written.
describe("turning core plugins on and off", () => {
	const installers = {
		"daily-notes": (app: any, host: any) => host.addCommand({ id: "daily-notes", name: "Open today's daily note", callback() {} }),
	};

	test("disabling removes what the plugin installed, enabling brings it back, and the choice outlives a restart", async () => {
		const storage: Record<string, unknown> = {};
		const files = { ".obsidian/core-plugins.json": { "daily-notes": true, "tag-pane": false } };
		const app = appWithConfig(files, storage);
		app.internalPlugins = new InternalPlugins(app);
		await app.internalPlugins.initialize();
		app.internalPlugins.install(installers);
		expect(app.commands.findCommand("daily-notes")).toBeDefined();
		app.internalPlugins.getPluginById("daily-notes").disable(true);
		expect(app.commands.findCommand("daily-notes")).toBeUndefined();
		app.internalPlugins.getPluginById("tag-pane").enable(true);

		const restarted = appWithConfig(files, storage);
		restarted.internalPlugins = new InternalPlugins(restarted);
		await restarted.internalPlugins.initialize();
		restarted.internalPlugins.install(installers);
		expect(restarted.internalPlugins.getEnabledPluginById("daily-notes")).toBeNull();
		expect(restarted.internalPlugins.getEnabledPluginById("tag-pane")).not.toBeNull();
		expect(restarted.commands.findCommand("daily-notes")).toBeUndefined();
		restarted.internalPlugins.getPluginById("daily-notes").enable(true);
		expect(restarted.commands.findCommand("daily-notes")).toBeDefined();
	});
});
