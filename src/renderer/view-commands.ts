import type { App } from "../api/app";
import type { Hotkey } from "../api/keymap";
import { MarkdownView } from "../api/markdown-view";
import { Platform } from "../api/util";
import { TextFileView, type View } from "../api/view";

// Commands that act on the active view, with Obsidian's ids and default hotkeys.
export function registerViewCommands(app: App) {
	const add = (id: string, name: string, hotkeys: Hotkey[], run: (view: View, checking: boolean) => boolean) =>
		app.commands.addCommand({
			id,
			name,
			hotkeys: hotkeys.length ? hotkeys : undefined,
			checkCallback: (checking) => {
				const view = app.workspace.activeLeaf?.view;
				return !!view && run(view, checking);
			},
		});
	const markdown = (when: (view: MarkdownView) => boolean, act: (view: MarkdownView) => any) => (view: View, checking: boolean) => {
		if (!(view instanceof MarkdownView) || !when(view)) return false;
		if (!checking) act(view);
		return true;
	};
	// Plugin views (latex-live) implement showSearch too.
	const search = (replace: boolean) => (view: View, checking: boolean) => {
		const show = (view as { showSearch?: (replace?: boolean) => void }).showSearch;
		if (typeof show !== "function") return false;
		if (!checking) show.call(view, replace);
		return true;
	};

	add(
		"markdown:toggle-preview",
		"Toggle reading view",
		[{ modifiers: ["Mod"], key: "e" }],
		markdown(
			() => true,
			(view) => view.toggleMode(),
		),
	);
	add(
		"editor:toggle-source",
		"Toggle Live Preview/Source mode",
		[],
		markdown(
			(view) => view.getMode() === "source",
			(view) => view.toggleSource(),
		),
	);
	add("editor:save-file", "Save current file", [{ modifiers: ["Mod"], key: "s" }], (view, checking) => {
		if (!(view instanceof TextFileView)) return false;
		if (!checking) view.save();
		return true;
	});
	add("editor:open-search", "Search current file", [{ modifiers: ["Mod"], key: "f" }], search(false));
	add(
		"editor:open-search-replace",
		"Search & replace in current file",
		[Platform.isMacOS ? { modifiers: ["Mod", "Alt"], key: "f" } : { modifiers: ["Mod"], key: "h" }],
		search(true),
	);
}
