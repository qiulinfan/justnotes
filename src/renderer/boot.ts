import * as nodePath from "node:path";
import { ipcRenderer } from "electron";
import { App } from "../api/app";
import { installDomExtensions, onWindowAdded } from "../api/dom";
import { editorSettings } from "../api/editor-settings";
import { setIcon } from "../api/icons";
import { registerEditorSuggests } from "../api/editor-suggests";
import { loadMathJax, setMarkdownApp } from "../api/markdown";
import { CodeCache } from "../api/code-cache";
import { FileMetadataStore } from "../api/metadata-store";
import { MarkdownView } from "../api/markdown-view";
import { installNativeSelectionScroll } from "../api/selection-scroll";
import { Notice } from "../api/ui/notice";
import { installTooltips } from "../api/ui/tooltip";
import { installAppearance } from "./appearance";
import { installBases } from "./bases-view";
import { installCli } from "./cli";
import { registerCodeView } from "./code-view";
import { registerCoreCommands } from "./commands";
import { installDevCapture } from "./dev-capture";
import { defaultRightSidebar, installCorePlugins, registerCorePluginViews } from "./core-plugins";
import { registerMediaViews } from "./media-view";
import { SearchView } from "./search";
import { registerPlainTextView } from "./plain-text-view";
import { installVaultSwitcher } from "./vault-switcher";
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
};

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

// Main's will-navigate guard keeps a link from replacing this page, but
// Chromium commits an about: URL (an <a href="about:blank#x"> in a plugin's
// view, say) without asking main, so the page cancels that navigation itself.
// Main's link policy sends about: nowhere either.
function keepAppPage() {
	navigation.addEventListener("navigate", (evt) => {
		if (new URL(evt.destination.url).protocol === "about:") evt.preventDefault();
	});
}

// Before the window closes, main asks the renderer to save open views, the
// layout, plugins' quit tasks and the metadata cache, and waits for the
// reply. A reload cannot wait, so it saves only the layout.
function handleWindowClose(app: App) {
	ipcRenderer.on("justnotes:before-close", async () => {
		try {
			await app.workspace.flushBeforeQuit();
			await app.metadataCache.saveStore().catch((err) => console.error("Could not save the metadata cache", err));
		} finally {
			ipcRenderer.send("justnotes:close-ready");
		}
	});
	ipcRenderer.send("justnotes:close-handler");
	// Popout windows close with the page, after the layout recorded them.
	window.addEventListener("beforeunload", () => {
		app.saveLayoutState();
		app.workspace.closePopoutsForUnload();
	});
	// A beforeunload handler (a plugin's) kept the page; main closes the
	// popouts it let go of.
	ipcRenderer.on("justnotes:unload-cancelled", () => app.workspace.unloadCancelled());
}

// Boot phases as User Timing marks (`justnotes:<phase>`), for profiles and
// for measuring startup over CDP: performance.getEntriesByType("mark").
const mark = (phase: string) => performance.mark(`justnotes:${phase}`);

async function boot() {
	mark("boot");
	installDevCapture();
	keepAppPage();
	installDomExtensions();
	installTooltips();
	const vaultPath = new URLSearchParams(location.search).get("vault");
	if (!vaultPath) throw new Error("No vault path given");
	const app = new App(vaultPath);
	(window as any).app = app;
	setMarkdownApp(app);
	const selectionScrollSpeed = () => editorSettings(app).selectionScrollSpeed;
	installNativeSelectionScroll(window, selectionScrollSpeed);
	onWindowAdded((win) => installNativeSelectionScroll(win, selectionScrollSpeed));
	document.title = `${app.vault.getName()} - justnotes`;

	app.viewRegistry.registerView("empty", (leaf) => new EmptyView(leaf));
	app.viewRegistry.registerView("markdown", (leaf) => new MarkdownView(leaf));
	app.viewRegistry.registerView("file-explorer", (leaf) => new FileExplorerView(leaf));
	app.viewRegistry.registerView("search", (leaf) => new SearchView(leaf));
	app.viewRegistry.registerExtensions(["md"], "markdown");
	registerPlainTextView(app);
	registerMediaViews(app);
	installBases(app);
	registerCorePluginViews(app);
	registerCodeView(app);

	buildShell(app);
	// What the last run kept in the profile: the metadata cache and plugins' compiled code.
	const profile: string = (window as any).require("@electron/remote").app.getPath("userData");
	app.metadataCache.useStore(FileMetadataStore.forVault(profile, app.vault.adapter.basePath));
	app.plugins.useCodeCache(new CodeCache(nodePath.join(profile, "code-cache", "plugins")));
	await app.vault.load();
	mark("vault-loaded");
	// Indexing overlaps the rest of boot and is done before plugins load, so
	// getFileCache() works in their onload, as in Obsidian.
	const indexed = app.metadataCache.initialize();
	installAppearance(app);
	await app.hotkeyManager.load();
	mark("hotkeys-loaded");
	await loadMathJax().catch((err) => console.error(err));
	mark("mathjax-loaded");
	registerCoreCommands(app);
	registerEditorSuggests(app);
	registerViewCommands(app);
	registerWorkspaceCommands(app);
	installVaultSwitcher(app);

	await indexed;
	mark("metadata-indexed");
	await app.metadataTypeManager.load();
	// Core plugins come before community plugins, which may read their options
	// while loading; both load before the layout, so it can restore their views.
	await app.internalPlugins.initialize();
	installCorePlugins(app);
	mark("core-plugins-loaded");
	await app.plugins.initialize();
	mark("plugins-loaded");
	await app.restoreLayoutState({ ...DEFAULT_LAYOUT, right: defaultRightSidebar(app) });
	mark("layout-restored");
	app.workspace.setLayoutReady();
	mark("layout-ready");
	hideLoading();
	handleWindowClose(app);
	installCli(app);

	const failed = Object.keys(app.plugins.manifests).filter((id) => !app.plugins.plugins[id]);
	if (failed.length) console.info("Plugins not loaded:", failed);
}

// The loading screen in index.html fades out once the layout is restored, or
// when boot fails, so the failure notice shows. A timer rather than an
// animation frame: a hidden window runs no frames.
function hideLoading() {
	const el = document.querySelector(".app-loading");
	if (!el) return;
	el.classList.add("is-done");
	window.setTimeout(() => el.remove(), 300);
}

boot().catch((err) => {
	hideLoading();
	console.error(err);
	new Notice(`justnotes failed to start: ${err.message}`, 0);
});
