import { describe, expect, test } from "bun:test";
import { InternalPlugins, parseCoreConfig } from "../src/api/internal-plugins";

function appWithConfig(files: Record<string, unknown>) {
	return {
		vault: {
			configDir: ".obsidian",
			adapter: {
				read: async (path: string) => {
					if (!(path in files)) throw new Error(`ENOENT: ${path}`);
					return JSON.stringify(files[path]);
				},
			},
		},
	} as any;
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
