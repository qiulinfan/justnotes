import type { App } from "../api/app";
import { MarkdownView } from "../api/markdown-view";
import type { SearchView } from "./search";
import { CommandPalette, QuickSwitcher } from "./views";

export function registerCoreCommands(app: App) {
	const add = (id: string, name: string, hotkey: [string[], string] | null, callback: () => any) =>
		app.commands.addCommand({ id, name, callback, hotkeys: hotkey ? [{ modifiers: hotkey[0] as any, key: hotkey[1] }] : undefined });
	add("command-palette:open", "Command palette: Open command palette", [["Mod"], "p"], () => new CommandPalette(app).open());
	add("switcher:open", "Quick switcher: Open quick switcher", [["Mod"], "o"], () => new QuickSwitcher(app).open());
	add("app:open-settings", "Open settings", [["Mod"], ","], () => app.setting.open());
	add("app:toggle-left-sidebar", "Toggle left sidebar", null, () => app.workspace.leftSplit.toggle());
	add("app:toggle-right-sidebar", "Toggle right sidebar", null, () => app.workspace.rightSplit.toggle());
	add("global-search:open", "Search: Search in all files", [["Mod", "Shift"], "f"], async () => {
		const leaf = await app.workspace.ensureSideLeaf("search", "left", { reveal: true });
		app.workspace.setActiveLeaf(leaf);
		const input = (leaf.view as SearchView).inputEl;
		input.focus();
		input.select();
	});
	add("app:reload", "Reload app without saving", [["Mod"], "r"], () => location.reload());
	add("workspace:new-tab", "New tab", [["Mod"], "t"], () => app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true }));
	add("workspace:close", "Close current tab", [["Mod"], "w"], () => app.workspace.activeLeaf?.detach());
	add("file-explorer:new-file", "Create new note", [["Mod"], "n"], async () => {
		const file = await app.fileManager.createNewMarkdownFile(app.fileManager.getNewFileParent(""));
		await app.workspace.getLeaf(false).openFile(file);
	});
	app.commands.addCommand({
		id: "editor:save-file",
		name: "Save current file",
		hotkeys: [{ modifiers: ["Mod"], key: "s" }],
		checkCallback: (checking) => {
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return false;
			if (!checking) view.save();
			return true;
		},
	});
}
