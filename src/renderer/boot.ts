import { ipcRenderer } from "electron";
import { App } from "../api/app";
import { installDomExtensions } from "../api/dom";
import { setIcon } from "../api/icons";
import { registerEditorSuggests } from "../api/editor-suggests";
import { loadMathJax, setMarkdownApp } from "../api/markdown";
import { MarkdownView } from "../api/markdown-view";
import { Notice } from "../api/ui/notice";
import { installTooltips } from "../api/ui/tooltip";
import { registerCoreCommands } from "./commands";
import { SearchView } from "./search";
import { registerViewCommands } from "./view-commands";
import { EmptyView, FileExplorerView } from "./views";
import { registerWorkspaceCommands } from "./workspace-commands";

// The layout of a vault opened for the first time.
const DEFAULT_LAYOUT = {
	left: {
		type: "split",
		direction: "horizontal",
		children: [{ type: "tabs", children: [{ type: "leaf", state: { type: "file-explorer" } }, { type: "leaf", state: { type: "search" } }] }],
	},
	right: { type: "split", direction: "horizontal", collapsed: true, children: [] },
};

async function applyTheme(app: App) {
	let theme = "system";
	try {
		theme = JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/appearance.json`)).theme ?? "system";
	} catch {}
	const media = window.matchMedia("(prefers-color-scheme: dark)");
	let dark: boolean | null = null;
	const apply = () => {
		const next = theme === "obsidian" || (theme !== "moonstone" && media.matches);
		if (next === dark) return;
		dark = next;
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

// Before the window closes, main asks the renderer to save open views, the
// layout and plugins' quit tasks, and waits for the reply. A reload cannot
// wait, so it saves only the layout.
function handleWindowClose(app: App) {
	ipcRenderer.on("justnotes:before-close", async () => {
		try {
			await app.workspace.flushBeforeQuit();
		} finally {
			ipcRenderer.send("justnotes:close-ready");
		}
	});
	ipcRenderer.send("justnotes:close-handler");
	window.addEventListener("beforeunload", () => app.saveLayoutState());
}

async function boot() {
	installDomExtensions();
	installTooltips();
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
	registerEditorSuggests(app);
	registerViewCommands(app);
	registerWorkspaceCommands(app);

	// Plugins load first so the layout can restore their views; layout-ready
	// callbacks then see every file's metadata.
	await app.plugins.initialize();
	const indexed = app.metadataCache.initialize();
	await app.restoreLayoutState(DEFAULT_LAYOUT);
	await indexed;
	app.workspace.setLayoutReady();
	handleWindowClose(app);

	const failed = Object.keys(app.plugins.manifests).filter((id) => !app.plugins.plugins[id]);
	if (failed.length) console.info("Plugins not loaded:", failed);
}

boot().catch((err) => {
	console.error(err);
	new Notice(`justnotes failed to start: ${err.message}`, 0);
});
