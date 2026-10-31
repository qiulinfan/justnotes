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
			const plugin = await loadedPlugin("typst", app);
			plugin.registerView("typst-view", () => ({}) as any);
			plugin.registerExtensions(["typ"], "typst-view");
			return plugin;
		};
		(await enable()).unload();
		expect(app.viewRegistry.getTypeByExtension("typ")).toBeUndefined();
		expect(app.viewRegistry.getViewCreatorByType("typst-view")).toBeUndefined();
		await enable();
		expect(app.viewRegistry.getTypeByExtension("typ")).toBe("typst-view");
	});
});
