import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions, nativeTheme, type Session, session, shell, type WebContents } from "electron";
import { enclosingVault } from "../cli/vaults";
import { startCli, trackCliWindow } from "./cli";
import { knownVaults, realPathOf, registerIpc, rememberVault, vaultNamed, vaultOf } from "./ipc";
import { setupWindowLifecycle } from "./lifecycle";
import { isLaunchData, isObsidianUrl, type LaunchData, type LaunchRequest, launchRequest } from "./launch-args";
import { droppedSchemes, sameAppPage } from "./link-policy";
import { microphoneRequest, systemMicrophoneAccess } from "./media";
import { isPopoutOpen } from "./popout";
import { registerPty } from "./pty";
import { handleSchemes, registerSchemes } from "./protocol";
import { currentVaultPicker, openVaultPicker } from "./vault-picker";
import { confirmUnknownVault, registerVaultSwitcher } from "./vault-switcher";

// @electron/remote resolves remote.require() through the real module tree, so
// it loads from node_modules at runtime instead of being bundled.
const remoteMain: { initialize(): void; enable(contents: WebContents): void } = createRequire(__filename)("@electron/remote/main");

function argValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

// `--profile <dir>` gives this instance its own Electron user data
// (localStorage, caches), so several instances can run side by side.
const profile = argValue("--profile");
// `--background` (scripts/smoke.ts): a test instance that never takes the
// user's focus. Its windows show inactive, and on macOS the app stays an
// accessory (no Dock icon, never activated), so it cannot steal keystrokes.
const background = process.argv.includes("--background");
if (profile) app.setPath("userData", path.resolve(profile));

// One instance per profile: Electron's lock lives in the user data folder, so
// instances with their own --profile stay independent. A second launch on a
// profile that is running hands its arguments (--vault folders, Markdown
// files, obsidian: URLs) to the running instance (second-instance below) and
// quits, so `justnotes` commands racing to start the app start it once.
const launchData: LaunchData = { argv: process.argv, cwd: process.cwd() };
const primary = app.requestSingleInstanceLock(launchData);
if (!primary) app.quit();
const firstLaunch = launchRequest(process.argv.slice(1), process.cwd());

// obsidian:// URLs are handled by the vault window (app.handleObsidianUrl),
// never by the OS, which would open Obsidian itself. They arrive as clicked
// links, window.open, macOS open-url events or launch arguments. justnotes does
// not register itself as the scheme's handler: that would take it from an
// installed Obsidian.
// The only URLs a <webview> guest's popups may hand to the system.
const isWebUrl = (url: string) => /^(https?|mailto):/i.test(url);
// Pages whose renderer listens for URLs. Until then a page's URLs wait in
// queuedUrls, and URLs that arrive before any window exists in earlyUrls,
// which the first page takes. A page stops listening when a new document
// commits (a reload).
const listening = new WeakSet<WebContents>();
const queuedUrls = new WeakMap<WebContents, string[]>();
const earlyUrls = [...firstLaunch.urls];

// Delivers an obsidian: URL to the window of `from`, or else to the focused one.
function sendObsidianUrl(url: string, from?: WebContents) {
	const win = (from && BrowserWindow.fromWebContents(from)) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	if (!win) earlyUrls.push(url);
	else if (listening.has(win.webContents)) win.webContents.send("justnotes:obsidian-url", url);
	else queuedUrls.set(win.webContents, [...(queuedUrls.get(win.webContents) ?? []), url]);
}

// Where a link opened from the app page goes, whether it arrives as
// window.open, as a navigation of the window or as a scheme Chromium would
// hand to the system: obsidian: URLs go to the vault window, the dropped
// schemes nowhere, and every other scheme (http, mailto, zotero:, other apps'
// schemes) to the system, as Obsidian hands any scheme to it.
function openUrl(url: string, from: WebContents) {
	let scheme: string;
	try {
		scheme = new URL(url).protocol;
	} catch {
		return;
	}
	if (scheme === "obsidian:") sendObsidianUrl(url, from);
	else if (!droppedSchemes.has(scheme)) shell.openExternal(url).catch((err) => console.error("Could not open", url, err));
}

// Plugins also reach this process's shell through remote; obsidian: URLs given
// to it go to the vault window too, never to the OS.
const openExternal = shell.openExternal.bind(shell);
shell.openExternal = async (url, options) => {
	if (isObsidianUrl(url)) sendObsidianUrl(url);
	else await openExternal(url, options);
};

ipcMain.handle("justnotes:obsidian-urls", (evt) => {
	listening.add(evt.sender);
	const urls = [...earlyUrls.splice(0), ...(queuedUrls.get(evt.sender) ?? [])];
	queuedUrls.delete(evt.sender);
	return urls;
});

// obsidian://open?path= (or new, or search) naming a file outside the sender's
// vault, as kgdistiller opens a record of another base: the vault that holds
// the file opens in its own window, or brings its open one to the front, and
// takes the URL, as Obsidian does. Only a vault once opened with --vault or
// the folder picker opens this way: a vault's window runs its community
// plugins, and a link must not run the code of a folder the user never chose.
// Resolves false when no such vault holds the file, and the sender says so in
// a notice.
ipcMain.handle("justnotes:open-in-vault", (evt, url: string, target: string) => {
	const vault = vaultOf(target, knownVaults());
	if (!vault || vaultWindows.get(vault)?.webContents === evt.sender) return false;
	sendObsidianUrl(url, openVault(vault).webContents);
	return true;
});

// An obsidian: URL whose vault= names another vault (QuickAdd writes
// obsidian://open?vault=<name>&file=..., and macOS hands URLs to the focused
// window) goes to that vault's window, opening it if needed, as in Obsidian:
// the one known vault of that folder name, never a path.
ipcMain.handle("justnotes:open-vault-named", (evt, url: string, name: string) => {
	const vault = vaultNamed(name, knownVaults());
	if (!vault || vaultWindows.get(vault)?.webContents === evt.sender) return false;
	sendObsidianUrl(url, openVault(vault).webContents);
	return true;
});

// A link to a scheme Chromium does not handle, when not caught as a main-frame
// navigation (from an iframe, say), makes Electron ask the page's session for
// the openExternal permission and then hand the URL to the OS. openUrl decides
// instead, in every session: a <webview> guest can have a session of its own
// (omp-sidebar's partition), and its links count as its embedder's, as a
// popout's (an iframe in it) count as its vault page's. Media
// (microphone and camera) is granted only as media.ts decides: the
// microphone, to a vault page, once macOS lets the app use it. Every other
// permission keeps Electron's default (granted).
function handlePermissions(ses: Session) {
	ses.setPermissionRequestHandler((contents, permission, callback, details) => {
		if (permission === "media") {
			const vaultPage = [...vaultWindows.values()].some((win) => win.webContents === contents);
			const media = "mediaTypes" in details ? details : null;
			if (!microphoneRequest(vaultPage, details.isMainFrame, media?.mediaTypes)) return callback(false);
			systemMicrophoneAccess().then(callback, () => callback(false));
			return;
		}
		if (permission !== "openExternal") return callback(true);
		callback(false);
		const url = "externalURL" in details ? details.externalURL : undefined;
		if (url) openUrl(url, contents.hostWebContents ?? popoutOpeners.get(contents) ?? contents);
	});
}
app.on("session-created", handlePermissions);

app.on("open-url", (evt, url) => {
	evt.preventDefault();
	sendObsidianUrl(url);
});

// A <webview> guest (omp-sidebar embeds one) never gets Node or a preload
// script, and its popups open in the system browser unless the plugin replaces
// this handler through remote (omp-sidebar does at dom-ready).
app.on("web-contents-created", (_evt, contents) => {
	contents.on("will-attach-webview", (_e, webPreferences) => {
		delete webPreferences.preload;
		webPreferences.nodeIntegration = false;
	});
	if (contents.getType() !== "webview") return;
	contents.setWindowOpenHandler(({ url }) => {
		if (isWebUrl(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
});

// The application menu, like Obsidian's. Electron's default menu had Close
// Window on Cmd+W and Reload on Cmd+R, so those keys could close the window or
// reload the page instead of running the close-tab and reload commands. Items
// that run a command show its default key without registering it
// (`registerAccelerator: false`): the key still reaches the renderer, where
// hotkeys.json may rebind it, and Minimize leaves Cmd+M to Quick LaTeX's
// inline math. The Edit roles stay because text fields and <webview> guests
// undo, copy and paste through them. View keeps the default menu's zoom
// (Cmd+0, Cmd+Plus, Cmd+-), which zooms the whole app as Obsidian's does, and
// full screen. Quit closes each window through its before-close flush
// (lifecycle.ts). Windows and Linux get no menu bar.
function setApplicationMenu() {
	if (process.platform !== "darwin") return Menu.setApplicationMenu(null);
	app.setAboutPanelOptions({ applicationName: "justnotes", applicationVersion: app.getVersion() });
	const command = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({
		label,
		accelerator,
		registerAccelerator: false,
		click: () => runCommand(id),
	});
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: "justnotes",
				submenu: [
					{ role: "about", label: "About justnotes" },
					{ type: "separator" },
					command("Settings…", "app:open-settings", "CmdOrCtrl+,"),
					{ type: "separator" },
					{ role: "services" },
					{ type: "separator" },
					{ role: "hide", label: "Hide justnotes" },
					{ role: "hideOthers" },
					{ role: "unhide" },
					{ type: "separator" },
					{ role: "quit", label: "Quit justnotes" },
				],
			},
			{
				label: "File",
				submenu: [
					command("New note", "file-explorer:new-file", "CmdOrCtrl+N"),
					command("New tab", "workspace:new-tab", "CmdOrCtrl+T"),
					{ type: "separator" },
					command("Quick switcher…", "switcher:open", "CmdOrCtrl+O"),
					command("Open vault…", "app:open-vault"),
					{ type: "separator" },
					command("Close tab", "workspace:close", "CmdOrCtrl+W"),
					{ label: "Close window", accelerator: "Shift+CmdOrCtrl+W", click: (_item, win) => win?.close() },
				],
			},
			{
				label: "Edit",
				submenu: [
					{ role: "undo" },
					{ role: "redo" },
					{ type: "separator" },
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "pasteAndMatchStyle" },
					{ role: "delete" },
					{ role: "selectAll" },
					{ type: "separator" },
					command("Search in all files", "global-search:open", "Shift+CmdOrCtrl+F"),
				],
			},
			{
				label: "View",
				submenu: [
					command("Command palette…", "command-palette:open", "CmdOrCtrl+P"),
					{ type: "separator" },
					command("Toggle left sidebar", "app:toggle-left-sidebar"),
					command("Toggle right sidebar", "app:toggle-right-sidebar"),
					{ type: "separator" },
					command("Reload", "app:reload", "CmdOrCtrl+R"),
					{ role: "toggleDevTools" },
					{ type: "separator" },
					{ role: "resetZoom" },
					{ role: "zoomIn" },
					{ role: "zoomOut" },
					{ type: "separator" },
					{ role: "togglefullscreen" },
				],
			},
			{ role: "window", submenu: [{ label: "Minimize", click: (_item, win) => win?.minimize() }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
			{
				role: "help",
				submenu: [
					{ label: "justnotes on GitHub", click: () => void shell.openExternal("https://github.com/qiulinfan/justnotes") },
					{ label: "Report an issue", click: () => void shell.openExternal("https://github.com/qiulinfan/justnotes/issues") },
				],
			},
		]),
	);
}

// Runs a command in the focused window's vault page (a popout's being its
// vault page's, which drives it).
function runCommand(id: string) {
	const focused = BrowserWindow.getFocusedWindow()?.webContents;
	const page = focused ? (popoutOpeners.get(focused) ?? focused) : [...vaultWindows.values()][0]?.webContents;
	page?.executeJavaScript(`window.app?.commands.executeCommandById(${JSON.stringify(id)})`).catch((err) => console.error("Could not run", id, err));
}

// Each popout's vault page, whose links its own count as (a popout's page
// listens for no obsidian: URLs).
const popoutOpeners = new WeakMap<WebContents, WebContents>();
// The popouts of each vault page kept open while the app quits (setupPopout).
const heldPopouts = new WeakMap<WebContents, Set<BrowserWindow>>();

// Set once the app quits (the menu, Cmd+Q, `justnotes quit` or `restart`).
let quitting = false;
app.on("before-quit", () => (quitting = true));

// A popout window is a child window of the vault page, in the same renderer:
// the page's own code builds and drives its document, as in Obsidian. Its links
// follow the same policy as the page's, it never navigates away from its blank
// document, and it closes with the page (a reload or the vault window closing).
function setupPopout(child: BrowserWindow, opener: WebContents) {
	const contents = child.webContents;
	popoutOpeners.set(contents, opener);
	contents.setWindowOpenHandler(({ url }) => {
		openUrl(url, opener);
		return { action: "deny" };
	});
	contents.on("will-navigate", (evt) => {
		if (!evt.isMainFrame) return;
		evt.preventDefault();
		openUrl(evt.url, opener);
	});
	const close = () => {
		if (!child.isDestroyed()) child.close();
	};
	const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
		if (details.isMainFrame && !details.isSameDocument) close();
	};
	// Quitting closes every window at once, popouts first on macOS (Electron
	// closes the newest first), while the vault window waits for its
	// before-close flush (lifecycle.ts): the page would drop their leaves and
	// save a layout without them. They stay until the page goes.
	child.on("close", (evt) => {
		if (!quitting || opener.isDestroyed()) return;
		evt.preventDefault();
		heldPopouts.set(opener, (heldPopouts.get(opener) ?? new Set()).add(child));
	});
	opener.once("destroyed", close);
	opener.on("did-start-navigation", onNavigation);
	child.once("closed", () => {
		if (opener.isDestroyed()) return;
		opener.off("destroyed", close);
		opener.off("did-start-navigation", onNavigation);
	});
}

// A beforeunload handler of the vault page (a plugin's) kept it from closing:
// Electron shows no dialog, the page stays and a quit in progress is over,
// as Electron cancels its own. The page has already let go of its popouts
// (closePopoutsForUnload), so the ones the quit held close now instead of
// staying open with no page driving them, and the page saves its layout
// again.
function unloadCancelled(contents: WebContents) {
	quitting = false;
	for (const child of heldPopouts.get(contents) ?? []) if (!child.isDestroyed()) child.close();
	heldPopouts.delete(contents);
	contents.send("justnotes:unload-cancelled");
}

// One window per vault, by the vault folder's real path. main creates every
// window, each with its own ?vault=, in this one process and profile.
const vaultWindows = new Map<string, BrowserWindow>();

// The theme a vault's page starts in, before its stylesheet and settings load:
// appearance.json's "theme" as the page applies it ("obsidian" dark,
// "moonstone" light), else the system's. The window's background takes it
// too, so opening a vault never flashes white.
function startTheme(vault: string): "dark" | "light" {
	try {
		const theme = JSON.parse(fs.readFileSync(path.join(vault, ".obsidian", "appearance.json"), "utf8")).theme;
		if (theme === "obsidian") return "dark";
		if (theme === "moonstone") return "light";
	} catch {}
	return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

// Opens a vault's window, or brings its open window to the front.
function openVault(vault: string) {
	const key = realPathOf(vault);
	const open = vaultWindows.get(key);
	if (open) return focusWindow(open);
	const win = createPageWindow({ vault }, startTheme(vault));
	vaultWindows.set(key, win);
	win.on("closed", () => vaultWindows.delete(key));
	trackCliWindow(win);
	return win;
}

// A file in no vault opens in a window of its own (?file=), by the file's
// real path: the page shows that file and what it links to, runs no plugins
// and writes no settings (boot.ts, single-file.ts). It is no vault: the vault
// list, the vault switcher and the command line never see it.
const fileWindows = new Map<string, BrowserWindow>();

function openFileWindow(file: string) {
	const key = realPathOf(file);
	const open = fileWindows.get(key);
	if (open) return focusWindow(open);
	const win = createPageWindow({ file }, startTheme(path.dirname(file)));
	fileWindows.set(key, win);
	win.on("closed", () => fileWindows.delete(key));
	return win;
}

function focusWindow(win: BrowserWindow) {
	if (win.isMinimized()) win.restore();
	win.focus();
	return win;
}

// The app page's window: index.html with `query` (?vault= or ?file=).
function createPageWindow(query: Record<string, string>, theme: "dark" | "light") {
	const win = new BrowserWindow({
		width: 1280,
		height: 860,
		show: !background,
		titleBarStyle: "hiddenInset",
		backgroundColor: theme === "dark" ? "#1e1e1e" : "#ffffff",
		webPreferences: {
			// Obsidian plugins call require("fs"), require("child_process") and
			// require("electron") directly, so the renderer needs Node.
			nodeIntegration: true,
			contextIsolation: false,
			sandbox: false,
			webSecurity: false,
			webviewTag: true,
		},
	});
	if (background) win.once("ready-to-show", () => win.showInactive());
	const contents = win.webContents;
	remoteMain.enable(contents);
	setupWindowLifecycle(win);
	contents.setWindowOpenHandler(({ url, frameName }) => {
		if (isPopoutOpen(url, frameName)) {
			return { action: "allow", overrideBrowserWindowOptions: { minWidth: 200, minHeight: 150, titleBarStyle: "default", autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: false, sandbox: false } } };
		}
		openUrl(url, contents);
		return { action: "deny" };
	});
	contents.on("did-create-window", (child) => setupPopout(child, contents));
	contents.on("will-prevent-unload", () => unloadCancelled(contents));
	// A link without a handler must not navigate the window away from the app;
	// it opens as from window.open instead. Chromium never asks about an about:
	// URL; the page cancels those navigations itself (boot.ts).
	contents.on("will-navigate", (evt) => {
		if (!evt.isMainFrame || sameAppPage(evt.url, contents.getURL())) return;
		evt.preventDefault();
		openUrl(evt.url, contents);
	});
	contents.on("did-navigate", () => listening.delete(contents));
	win.loadFile(path.join(__dirname, "index.html"), { query: { ...query, theme } }).catch((err) => console.error("Could not load the window of", query, err));
	return win;
}

// The left sidebar's vault switcher lists, opens and adds vaults through main.
registerVaultSwitcher(vaultWindows, openVault);

// Markdown files opened from the system: Finder's double-click and Open With
// arrive as open-file events, at launch before the app is ready; Windows and
// Linux pass them as arguments. Those that come before the first windows
// open wait in launchFiles.
const launchFiles = [...firstLaunch.files];
let started = false;
app.on("open-file", (evt, file) => {
	evt.preventDefault();
	if (started) void openFile(file);
	else launchFiles.push(file);
});

// A note opens in the vault that holds it: a vault opened before, else the
// nearest folder above with .obsidian, and then as obsidian://open?path=
// opens it. A vault not opened before is confirmed first, because its window
// runs the vault's community plugins; once confirmed, links may open it as
// well. A note in no vault opens alone in a file window.
async function openFile(file: string) {
	file = path.resolve(file);
	const known = vaultOf(file, knownVaults());
	const vault = known ?? enclosingVault(path.dirname(file));
	if (!vault) return void openFileWindow(file);
	if (!known) {
		if (!(await confirmUnknownVault(vault, `${file} is in no vault justnotes has opened.`))) return;
		rememberVault(vault);
	}
	sendObsidianUrl(`obsidian://open?path=${encodeURIComponent(file)}`, openVault(vault).webContents);
}

// The first vaults come from `--vault <path>` (repeatable: `justnotes
// restart` reopens every vault window) and from the Markdown files the app
// was opened with; without either the vault picker (vault-picker.ts) lets the
// user choose one. The user chose them, so links may open them from now on.
async function openFirstVaults() {
	const vaults = firstLaunch.vaults;
	const files = launchFiles.splice(0);
	started = true;
	if (!vaults.length && !files.length) return void openVaultPicker(background);
	await openLaunch({ vaults, files, urls: [] });
}

function openLaunch(launch: LaunchRequest) {
	for (const vault of launch.vaults) {
		rememberVault(vault);
		openVault(vault);
	}
	for (const url of launch.urls) sendObsidianUrl(url);
	return launch.files.reduce((done, file) => done.then(() => openFile(file)), Promise.resolve());
}

// A second launch on this profile: what it was opened with opens here, or
// with nothing to open, the focused (else the first) vault window comes to
// the front. While the app quits its arguments are dropped; the `justnotes`
// command starts the app again when no socket comes up.
function onSecondInstance(argv: string[], cwd: string, data: unknown) {
	if (quitting) return;
	const sent = isLaunchData(data) ? data : { argv, cwd };
	const launch = launchRequest(sent.argv.slice(1), sent.cwd);
	if (launch.vaults.length || launch.files.length || launch.urls.length) return void openLaunch(launch);
	const win = BrowserWindow.getFocusedWindow() ?? [...vaultWindows.values()][0] ?? currentVaultPicker();
	if (win?.isMinimized()) win.restore();
	win?.focus();
}

if (primary) {
	remoteMain.initialize();
	registerSchemes();
	registerIpc();
	registerPty();
	app.on("second-instance", (_evt, argv, cwd, data) => onSecondInstance(argv, cwd, data));
	app.whenReady().then(() => {
		if (background && process.platform === "darwin") app.setActivationPolicy("accessory");
		handleSchemes();
		handlePermissions(session.defaultSession);
		setApplicationMenu();
		// The packaged app carries the icon in its bundle; run from the repo, the
		// Dock would show Electron's.
		if (!app.isPackaged && !background && process.platform === "darwin") {
			const icon = path.join(__dirname, "..", "packaging", "icon.png");
			if (fs.existsSync(icon)) app.dock?.setIcon(icon);
		}
		startCli(vaultWindows, openVault).catch((err) => console.error("The command line socket could not start", err));
		return openFirstVaults();
	});
}
app.on("window-all-closed", () => app.quit());
