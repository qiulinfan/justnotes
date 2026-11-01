import type { App } from "../../api/app";
import type { Menu } from "../../api/ui/menu";
import type { CorePluginHost } from "../../api/internal-plugins";
import { type TAbstractFile, type TFile, TFolder } from "../../api/vault";
import { FileView } from "../../api/view";
import { WorkspaceLeaf, WorkspaceTabs } from "../../api/workspace";
import { TerminalService } from "./service";
import { TerminalSettingTab } from "./settings";
import { TerminalView, VIEW_TYPE } from "./terminal-view";

type Place = "tab" | "right" | "below";

// The note the user was last in: the active file view's, else the most
// recently active one's (with a terminal active, getActiveFile has none).
function recentFile(app: App): TFile | null {
	let best: { leaf: WorkspaceLeaf; file: TFile } | null = null;
	app.workspace.iterateAllLeaves((leaf) => {
		const view = leaf.view;
		if (view instanceof FileView && view.file && (!best || leaf.activeTime > best.leaf.activeTime)) best = { leaf, file: view.file };
	});
	return (best as { file: TFile } | null)?.file ?? null;
}

// The Terminal core plugin (justnotes' own): shells in `terminal` views, its
// commands and ribbon button, a folder menu item and its settings. While it
// is on, the community plugin `terminal` is not loaded (plugins.ts).
export function installTerminal(app: App, host: CorePluginHost) {
	const service = new TerminalService(app);
	host.register(() => service.destroy());
	host.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, service));
	host.registerEvent(app.workspace.on("css-change", () => service.refresh()));
	host.addSettingTab(new TerminalSettingTab(app, service));
	// The community plugin goes first (turned on at runtime), and comes back when this goes.
	host.register(() => app.plugins.coreReplacementStopped(host.id));
	void app.plugins.coreReplacementStarted(host.id);

	const folderOf = (file: TAbstractFile | null) => {
		if (!file) return null;
		const folder = file instanceof TFolder ? file : file.parent;
		return folder ? service.fullPath(folder.path) : null;
	};
	const startFolder = () => (service.settings.cwd === "active" ? folderOf(recentFile(app)) : null) ?? service.vaultRoot();

	// The tab group of a terminal already open in the main area, if any.
	const terminalTabs = () => {
		for (const view of service.views) {
			const parent = view.leaf.parent;
			if (parent instanceof WorkspaceTabs && app.workspace.inMainArea(view.leaf)) return parent;
		}
		return null;
	};
	// Below the editor by default, as in VS Code: a split under the note the
	// first time, then further terminals as tabs of that group.
	const newLeaf = (place: Place) => {
		if (place === "tab") return app.workspace.getLeaf("tab");
		if (place === "right") return app.workspace.getLeaf("split", "vertical");
		const tabs = terminalTabs();
		if (!tabs) return app.workspace.getLeaf("split", "horizontal");
		const leaf = new WorkspaceLeaf(app);
		tabs.insertChild(tabs.children.length, leaf);
		return leaf;
	};
	const open = async (cwd: string, place: Place = "below") => {
		const leaf = newLeaf(place);
		await leaf.setViewState({ type: VIEW_TYPE, state: { cwd }, active: true });
		app.workspace.setActiveLeaf(leaf, { focus: true });
		(leaf.view as TerminalView).focus();
		return leaf;
	};
	const activeTerminal = () => {
		const view = app.workspace.activeLeaf?.view;
		return view instanceof TerminalView ? view : null;
	};

	host.addRibbonIcon("terminal:open", "square-terminal", "Open terminal", () => void open(startFolder()));
	host.addCommand({ id: "terminal:open", name: "Terminal: Open terminal", callback: () => void open(startFolder()) });
	host.addCommand({
		id: "terminal:open-in-current-folder",
		name: "Terminal: Open terminal in current folder",
		checkCallback: (checking) => {
			const cwd = folderOf(recentFile(app));
			if (!cwd) return false;
			if (!checking) void open(cwd);
			return true;
		},
	});
	host.addCommand({ id: "terminal:open-right", name: "Terminal: Open terminal to the right", callback: () => void open(startFolder(), "right") });
	host.addCommand({ id: "terminal:open-below", name: "Terminal: Open terminal below", callback: () => void open(startFolder(), "below") });
	// Into the last terminal, or back out of it; with none open, a new one below.
	host.addCommand({
		id: "terminal:toggle",
		name: "Terminal: Toggle terminal",
		hotkeys: [{ modifiers: ["Ctrl"], key: "`" }],
		callback: () => {
			const doc = activeDocument;
			const focused = [...service.views].find((v) => v.containerEl.contains(doc.activeElement));
			if (focused) {
				let back: WorkspaceLeaf | null = null;
				app.workspace.iterateAllLeaves((leaf) => {
					if (leaf.view instanceof TerminalView || !app.workspace.inMainArea(leaf)) return;
					if (!back || leaf.activeTime > back.activeTime) back = leaf;
				});
				if (back) app.workspace.setActiveLeaf(back, { focus: true });
				return;
			}
			const last = service.lastFocused && service.views.has(service.lastFocused) ? service.lastFocused : [...service.views][0];
			if (!last) return void open(startFolder(), "below");
			void app.workspace.revealLeaf(last.leaf).then(() => {
				app.workspace.setActiveLeaf(last.leaf, { focus: true });
				last.focus();
			});
		},
	});
	host.addCommand({
		id: "terminal:clear",
		name: "Terminal: Clear terminal",
		checkCallback: (checking) => {
			const view = activeTerminal();
			if (view && !checking) view.clear();
			return !!view;
		},
	});
	host.addCommand({
		id: "terminal:find",
		name: "Terminal: Find in terminal",
		checkCallback: (checking) => {
			const view = activeTerminal();
			if (view && !checking) view.openFind();
			return !!view;
		},
	});
	host.addCommand({
		id: "terminal:restart",
		name: "Terminal: Restart terminal",
		checkCallback: (checking) => {
			const view = activeTerminal();
			if (view && !checking) view.restart();
			return !!view;
		},
	});
	host.registerEvent(
		app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
			const cwd = folderOf(file);
			if (!cwd) return;
			menu.addItem((item) =>
				item
					.setSection("open")
					.setTitle("Open in terminal")
					.setIcon("square-terminal")
					.onClick(() => void open(cwd)),
			);
		}),
	);
}
