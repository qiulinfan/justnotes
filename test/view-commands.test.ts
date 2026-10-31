import { describe, expect, test } from "bun:test";
import { Commands, HotkeyManager } from "../src/api/keymap";
import { TextFileView } from "../src/api/view";
import { registerViewCommands } from "../src/renderer/view-commands";

// tinymist's Typst editor is a TextFileView of its own with a showSearch
// method, and it leaves Mod-S and Mod-F to Obsidian's commands: Save current
// file and Search current file must act on it as on a note.
describe("view commands", () => {
	test("Save current file and Search current file act on a plugin's text file view", () => {
		const calls: string[] = [];
		const view: TextFileView = Object.assign(Object.create(TextFileView.prototype), {
			save: async () => void calls.push("save"),
			showSearch: (replace: boolean) => void calls.push(replace ? "replace" : "find"),
		});
		const app: any = { workspace: { activeLeaf: { view }, activeEditor: null }, lastEvent: null };
		app.hotkeyManager = new HotkeyManager(app);
		app.commands = new Commands(app);
		registerViewCommands(app);
		expect(app.commands.executeCommandById("editor:save-file")).toBe(true);
		expect(app.commands.executeCommandById("editor:open-search")).toBe(true);
		expect(app.commands.executeCommandById("editor:open-search-replace")).toBe(true);
		expect(calls).toEqual(["save", "find", "replace"]);
	});
});
