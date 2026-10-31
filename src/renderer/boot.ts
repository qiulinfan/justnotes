import { App } from "../api/app";
import { installDomExtensions } from "../api/dom";
import { setIcon } from "../api/icons";
import { loadMathJax, setMarkdownApp } from "../api/markdown";
import { MarkdownView } from "../api/markdown-view";
import { Notice } from "../api/ui/notice";
import { registerCoreCommands } from "./commands";
import { SearchView } from "./search";
import { registerViewCommands } from "./view-commands";
import { EmptyView, FileExplorerView } from "./views";

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
	registerViewCommands(app);
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
