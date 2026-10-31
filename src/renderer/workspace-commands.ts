import type { App } from "../api/app";
import type { Hotkey, Modifier } from "../api/keymap";
import type { WorkspaceLeaf, WorkspaceTabs } from "../api/workspace";

// Obsidian's navigation, split and tab commands, with its ids and default keys.
export function registerWorkspaceCommands(app: App) {
	const { workspace } = app;
	const keys = (modifiers: Modifier[], key: string): Hotkey[] => [{ modifiers, key }];
	// `run` says whether the command applies to the active leaf, and acts only
	// when `act` is true (not while the palette or a hotkey just checks).
	const command = (id: string, name: string, hotkeys: Hotkey[] | undefined, run: (leaf: WorkspaceLeaf, act: boolean) => boolean) =>
		app.commands.addCommand({
			id,
			name,
			hotkeys,
			checkCallback: (checking) => {
				const leaf = workspace.activeLeaf;
				return !!leaf?.parent && run(leaf, !checking);
			},
		});
	const when = (ok: boolean, act: boolean, action: () => unknown) => {
		if (ok && act) action();
		return ok;
	};
	const tabs = (leaf: WorkspaceLeaf) => (leaf.parent as WorkspaceTabs).children;
	// Closing several tabs spares pinned ones.
	const closable = (leaf: WorkspaceLeaf) => tabs(leaf).filter((l) => !l.pinned && l !== leaf);
	const select = (leaf: WorkspaceLeaf, act: boolean, index: number) => {
		const target = tabs(leaf)[index];
		return when(!!target && target !== leaf, act, () => workspace.setActiveLeaf(target, { focus: true }));
	};

	command("app:go-back", "Navigate back", keys(["Mod", "Alt"], "ArrowLeft"), (leaf, act) => when(leaf.history.backHistory.length > 0, act, () => leaf.history.back()));
	command("app:go-forward", "Navigate forward", keys(["Mod", "Alt"], "ArrowRight"), (leaf, act) =>
		when(leaf.history.forwardHistory.length > 0, act, () => leaf.history.forward()),
	);
	command("workspace:split-vertical", "Split right", undefined, (leaf, act) => when(true, act, () => workspace.duplicateLeaf(leaf, "split", "vertical")));
	command("workspace:split-horizontal", "Split down", undefined, (leaf, act) => when(true, act, () => workspace.duplicateLeaf(leaf, "split", "horizontal")));
	// A tab in a sidebar has no window of its own to go to, nor has the only tab
	// of a popout.
	command("workspace:open-in-new-window", "Open current tab in new window", undefined, (leaf, act) =>
		when(workspace.inMainArea(leaf), act, () => workspace.duplicateLeaf(leaf, "window")),
	);
	command("workspace:move-to-new-window", "Move current tab to new window", undefined, (leaf, act) =>
		when(workspace.inMainArea(leaf) && !workspace.isOnlyLeafOfWindow(leaf), act, () => workspace.moveLeafToPopout(leaf)),
	);
	command("workspace:toggle-pin", "Toggle pin", undefined, (leaf, act) => when(true, act, () => leaf.togglePinned()));
	command("workspace:close-others", "Close all other tabs", undefined, (leaf, act) =>
		when(closable(leaf).length > 0, act, () => {
			for (const other of closable(leaf)) other.detach();
		}),
	);
	command("workspace:close-tab-group", "Close this tab group", undefined, (leaf, act) =>
		when(true, act, () => {
			for (const other of closable(leaf)) other.detach();
			if (!leaf.pinned) leaf.detach();
		}),
	);
	command("workspace:next-tab", "Go to next tab", keys(["Ctrl"], "Tab"), (leaf, act) => select(leaf, act, (tabs(leaf).indexOf(leaf) + 1) % tabs(leaf).length));
	command("workspace:previous-tab", "Go to previous tab", keys(["Ctrl", "Shift"], "Tab"), (leaf, act) =>
		select(leaf, act, (tabs(leaf).indexOf(leaf) - 1 + tabs(leaf).length) % tabs(leaf).length),
	);
	for (let n = 1; n <= 8; n++) command(`workspace:goto-tab-${n}`, `Go to tab #${n}`, keys(["Mod"], String(n)), (leaf, act) => select(leaf, act, n - 1));
	command("workspace:goto-last-tab", "Go to last tab", keys(["Mod"], "9"), (leaf, act) => select(leaf, act, tabs(leaf).length - 1));
	app.commands.addCommand({
		id: "workspace:undo-close-pane",
		name: "Undo close tab",
		hotkeys: keys(["Mod", "Shift"], "t"),
		callback: () => workspace.undoCloseLeaf(),
	});
	app.commands.addCommand({
		id: "file-explorer:open",
		name: "Files: Show file explorer",
		callback: () => workspace.ensureSideLeaf("file-explorer", "left", { reveal: true }),
	});
}
