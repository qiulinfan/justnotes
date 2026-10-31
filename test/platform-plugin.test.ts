import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { MarkdownPreviewRenderer } from "../src/api/markdown";
import { Plugin } from "../src/api/plugin";
import { ViewRegistry } from "../src/api/view";

installLanguageExtensions();

async function loadedPlugin(id: string, app: any = {}) {
	const plugin = new Plugin(app, { id, name: id, version: "1.0.0", minAppVersion: "", author: "", description: "" });
	await plugin.load();
	return plugin;
}

// Live Preview renders a fence with the handler in codeBlockPostProcessors.
describe("Plugin.registerMarkdownCodeBlockProcessor", () => {
	test("unloading the first of two plugins that handle a language keeps the second one's handler", async () => {
		const first = await loadedPlugin("first");
		const second = await loadedPlugin("second");
		const firstHandler = () => {};
		const secondHandler = () => {};
		first.registerMarkdownCodeBlockProcessor("platform-lang", firstHandler);
		second.registerMarkdownCodeBlockProcessor("platform-lang", secondHandler);
		first.unload();
		expect(MarkdownPreviewRenderer.codeBlockPostProcessors["platform-lang"]).toBe(secondHandler);
		second.unload();
		expect("platform-lang" in MarkdownPreviewRenderer.codeBlockPostProcessors).toBe(false);
	});
});

// A plugin turned off and on again (in Settings, or to update it) loads as a
// new instance: what the old one registered must be gone, or registering the
// view type again throws and the plugin fails to load; while it is off, its
// files must not open in a view no plugin provides.
describe("Plugin.registerView and registerExtensions", () => {
	test("unloading releases the view type and the file extensions, so the plugin loads again", async () => {
		const app = { viewRegistry: new ViewRegistry() };
		const enable = async () => {
			const plugin = await loadedPlugin("sketch", app);
			plugin.registerView("sketch-view", () => ({}) as any);
			plugin.registerExtensions(["sketch"], "sketch-view");
			return plugin;
		};
		(await enable()).unload();
		expect(app.viewRegistry.getTypeByExtension("sketch")).toBeUndefined();
		expect(app.viewRegistry.getViewCreatorByType("sketch-view")).toBeUndefined();
		await enable();
		expect(app.viewRegistry.getTypeByExtension("sketch")).toBe("sketch-view");
	});
});

// A plugin's ribbon button goes with the plugin, and only its own: buttons
// were once removed by title, so unloading a plugin whose button said "Open
// quick switcher" removed the host's switcher button and kept its own entry.
describe("Plugin.addRibbonIcon", () => {
	test("unloading removes the plugin's button, not another with the same title", async () => {
		type Item = { id: string; title: string; buttonEl: { detached: boolean; detach(): void } };
		const ribbon = {
			items: [] as Item[],
			addRibbonItemButton(id: string, _icon: string, title: string) {
				const buttonEl = { detached: false, detach: () => (buttonEl.detached = true) };
				this.items.push({ id, title, buttonEl });
				return buttonEl;
			},
			removeRibbonAction(title: string) {
				const index = this.items.findIndex((i) => i.title === title);
				if (index >= 0) this.items.splice(index, 1)[0].buttonEl.detach();
			},
		};
		const host = ribbon.addRibbonItemButton("switcher", "file-search", "Open quick switcher");
		const plugin = await loadedPlugin("dup", { workspace: { leftRibbon: ribbon } });
		plugin.addRibbonIcon("dice", "Open quick switcher", () => {});
		plugin.unload();
		expect(ribbon.items.map((i) => i.id)).toEqual(["switcher"]);
		expect(host.detached).toBe(false);
	});
});
