import { App } from "../api/app";
import { installDomExtensions } from "../api/dom";
import { setIcon } from "../api/icons";
import { loadMathJax, setMarkdownApp } from "../api/markdown";
import { MarkdownView } from "../api/markdown-view";
import { Notice } from "../api/ui/notice";
import { SearchView } from "./search";
import { CommandPalette, EmptyView, FileExplorerView, QuickSwitcher } from "./views";

async function applyTheme(app: App) {
	let theme = "system";
	try {
		theme = JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/appearance.json`)).theme ?? "system";
	} catch {}
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	const apply = () => {
		const dark = theme === "obsidian" || (theme !== "moonstone" && media.matches);
		document.body.toggleClass("theme-dark", dark);
		document.body.toggleClass("theme-light", !dark);
		app.workspace.trigger("css-change");
	};
	media.addEventListener("change", apply);
	apply();
}

function registerCoreCommands(app: App) {
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

function buildShell(app: App) {
	const root = document.body.createDiv("app-container");
	app.dom.appContainerEl = root;
	root.createDiv({ cls: "titlebar", text: app.vault.getName() });
	const main = root.createDiv("horizontal-main-container");
	main.appendChild(app.workspace.containerEl);
	root.appendChild(app.statusBar);
	const ribbon = app.workspace.leftRibbon;
	ribbon.addRibbonItemButton("toggle-left", "panel-left", "Toggle left sidebar", () => app.workspace.leftSplit.toggle());
	ribbon.addRibbonItemButton("switcher", "file-search", "Open quick switcher", () => app.commands.executeCommandById("switcher:open"));
	ribbon.addRibbonItemButton("palette", "terminal-square", "Open command palette", () => app.commands.executeCommandById("command-palette:open"));
	const settings = ribbon.containerEl.createDiv("side-dock-settings");
	const gear = settings.createDiv("clickable-icon side-dock-ribbon-action");
	gear.setAttr("aria-label", "Settings");
	setIcon(gear, "settings");
	gear.addEventListener("click", () => app.setting.open());
}

async function boot() {
	installDomExtensions();
	const vaultPath = new URLSearchParams(location.search).get("vault");
	if (!vaultPath) throw new Error("No vault path given");
	const app = new App(vaultPath);
	(window as any).app = app;
	setMarkdownApp(app);
	document.title = `${app.vault.getName()} - justnotes`;

	app.viewRegistry.registerView("empty", (leaf) => new EmptyView(leaf));
	app.viewRegistry.registerView("markdown", (leaf) => new MarkdownView(leaf));
	app.viewRegistry.registerView("file-explorer", (leaf) => new FileExplorerView(leaf));
	app.viewRegistry.registerView("search", (leaf) => new SearchView(leaf));
	app.viewRegistry.registerExtensions(["md"], "markdown");

	buildShell(app);
	await app.vault.load();
	await applyTheme(app);
	await app.hotkeyManager.load();
	await loadMathJax().catch((err) => console.error(err));
	registerCoreCommands(app);
	await app.workspace.getLeftLeaf(false).setViewState({ type: "file-explorer" });
	await app.workspace.getLeftLeaf(false).setViewState({ type: "search" });
	app.workspace.revealLeaf(app.workspace.getLeavesOfType("file-explorer")[0]);

	await app.plugins.initialize();
	await app.restoreLayoutState();
	if (!app.workspace.getMostRecentLeaf()) app.workspace.getLeaf(false);
	app.workspace.setLayoutReady();
	app.metadataCache.initialize();

	const failed = Object.keys(app.plugins.manifests).filter((id) => !app.plugins.plugins[id]);
	if (failed.length) console.info("Plugins not loaded:", failed);
}

boot().catch((err) => {
	console.error(err);
	new Notice(`justnotes failed to start: ${err.message}`, 0);
});
