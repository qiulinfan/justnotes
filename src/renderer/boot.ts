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
import { installUpdates } from "../api/updates";
import { installAppearance } from "./appearance";
import { installBases } from "./bases-view";
import { installCli } from "./cli";
import { registerCodeView } from "./code-view";
import { registerCoreCommands } from "./commands";
import { installDevCapture } from "./dev-capture";
import { defaultRightSidebar, installCorePlugins, registerCorePluginViews } from "./core-plugins";
import { registerEpubView } from "./epub/epub-view";
import { registerMediaViews } from "./media-view";
import { SearchView } from "./search";
import { registerPlainTextView } from "./plain-text-view";
import { installSingleFile, singleFileLayout } from "./single-file";
import { installRightSidebarToggle } from "./sidebar-toggle";
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
	root.createDiv({ cls: "titlebar", text: app.vault.singleFile ?? app.vault.getName() });
	// In fullscreen macOS shows the window buttons only in the bar that slides
	// down with the menu bar, so the title bar strip would stay empty there:
	// body.is-fullscreen (as in Obsidian) hides it. Main reports the changes.
	const fullscreen = (on: boolean) => document.body.toggleClass("is-fullscreen", on);
	fullscreen((window as any).require("@electron/remote").getCurrentWindow().isFullScreen());
	ipcRenderer.on("justnotes:fullscreen", (_evt: unknown, on: boolean) => fullscreen(on));
	const main = root.createDiv("horizontal-main-container");
	main.appendChild(app.workspace.containerEl);
	root.appendChild(app.statusBar);
	const ribbon = app.workspace.leftRibbon;
	ribbon.addRibbonItemButton("toggle-left", "panel-left", "Toggle left sidebar", () => app.workspace.leftSplit.toggle());
	installRightSidebarToggle(app);
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
	// ?vault= opens a vault; ?file= a file in no vault, alone (single-file.ts).
	const params = new URLSearchParams(location.search);
	const filePath = params.get("file");
	const vaultPath = filePath ? nodePath.dirname(filePath) : params.get("vault");
	if (!vaultPath) throw new Error("No vault path given");
	const app = new App(vaultPath, filePath ? nodePath.basename(filePath) : null);
	const single = app.vault.singleFile;
	(window as any).app = app;
	setMarkdownApp(app);
	const selectionScrollSpeed = () => editorSettings(app).selectionScrollSpeed;
	installNativeSelectionScroll(window, selectionScrollSpeed);
	onWindowAdded((win) => installNativeSelectionScroll(win, selectionScrollSpeed));
	document.title = `${single ?? app.vault.getName()} - justnotes`;

	app.viewRegistry.registerView("empty", (leaf) => new EmptyView(leaf));
	app.viewRegistry.registerView("markdown", (leaf) => new MarkdownView(leaf));
	app.viewRegistry.registerView("file-explorer", (leaf) => new FileExplorerView(leaf));
	app.viewRegistry.registerView("search", (leaf) => new SearchView(leaf));
	app.viewRegistry.registerExtensions(["md"], "markdown");
	registerPlainTextView(app);
	registerMediaViews(app);
	registerEpubView(app);
	installBases(app);
	registerCorePluginViews(app);
	registerCodeView(app);

	buildShell(app);
	// What the last run kept in the profile: the metadata cache and plugins'
	// compiled code. A file's window has a few files to parse and no plugins.
	const profile: string = (window as any).require("@electron/remote").app.getPath("userData");
	if (!single) {
		app.metadataCache.useStore(FileMetadataStore.forVault(profile, app.vault.adapter.basePath));
		app.plugins.useCodeCache(new CodeCache(nodePath.join(profile, "code-cache", "plugins")));
	}
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
	if (!single) installVaultSwitcher(app);
	installUpdates(app);

	await indexed;
	mark("metadata-indexed");
	await app.metadataTypeManager.load();
	// Core plugins come before community plugins, which may read their options
	// while loading; both load before the layout, so it can restore their views.
	await app.internalPlugins.initialize();
	installCorePlugins(app);
	mark("core-plugins-loaded");
	if (single) await app.workspace.changeLayout(singleFileLayout());
	else {
		await app.plugins.initialize();
		mark("plugins-loaded");
		await app.restoreLayoutState({ ...DEFAULT_LAYOUT, right: defaultRightSidebar(app) });
		mark("layout-restored");
	}
	app.workspace.setLayoutReady();
	mark("layout-ready");
	// After layout-ready, where core plugins such as LaTeX register their views.
	if (single) await openSingleFile(app, single);
	hideLoading();
	handleWindowClose(app);
	if (!single) installCli(app);

	const failed = Object.keys(app.plugins.manifests).filter((id) => !app.plugins.plugins[id]);
	if (failed.length) console.info("Plugins not loaded:", failed);
}

// A file's window opens its file and lets in what it refers to.
async function openSingleFile(app: App, name: string) {
	const file = app.vault.getFileByPath(name);
	if (!file) {
		new Notice(`${name} could not be opened.`, 0);
		return;
	}
	// The LaTeX core plugin registers the .tex view once it has loaded, after
	// layout-ready; until then a TeX file would open in the code view.
	if (file.extension === "tex" && app.internalPlugins.getEnabledPluginById("latex") && !app.viewRegistry.getTypeByExtension("tex")) {
		await new Promise<void>((resolve) => {
			const ref = app.workspace.on("latex-live:api-ready" as any, done);
			const timer = window.setTimeout(done, 5000);
			function done() {
				app.workspace.offref(ref);
				window.clearTimeout(timer);
				resolve();
			}
		});
	}
	await app.workspace.getLeaf(false).openFile(file);
	await installSingleFile(app, file);
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
