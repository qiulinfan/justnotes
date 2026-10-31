import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { MarkdownPreviewRenderer } from "../src/api/markdown";
import { Plugin } from "../src/api/plugin";

installLanguageExtensions();

async function loadedPlugin(id: string) {
	const plugin = new Plugin({} as any, { id, name: id, version: "1.0.0", minAppVersion: "", author: "", description: "" });
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
