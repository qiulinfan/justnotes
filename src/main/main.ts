import { createRequire } from "node:module";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, type Session, session, shell, type WebContents } from "electron";
import { startCli, trackCliWindow } from "./cli";
import { knownVaults, realPathOf, registerIpc, rememberVault, vaultOf } from "./ipc";
import { setupWindowLifecycle } from "./lifecycle";
import { droppedSchemes } from "./link-policy";
import { microphoneRequest, systemMicrophoneAccess } from "./media";
import { isPopoutOpen } from "./popout";
import { handleSchemes, registerSchemes } from "./protocol";

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
if (profile) app.setPath("userData", path.resolve(profile));

// obsidian:// URLs are handled by the vault window (app.handleObsidianUrl),
// never by the OS, which would open Obsidian itself. They arrive as clicked
// links, window.open, macOS open-url events or launch arguments. justnotes does
// not register itself as the scheme's handler: that would take it from an
// installed Obsidian.
const isObsidianUrl = (url: string) => /^obsidian:/i.test(url);
// The only URLs a <webview> guest's popups may hand to the system.
const isWebUrl = (url: string) => /^(https?|mailto):/i.test(url);
// Pages whose renderer listens for URLs. Until then a page's URLs wait in
// queuedUrls, and URLs that arrive before any window exists in earlyUrls,
// which the first page takes. A page stops listening when a new document
// commits (a reload).
const listening = new WeakSet<WebContents>();
const queuedUrls = new WeakMap<WebContents, string[]>();
const earlyUrls = process.argv.filter(isObsidianUrl);

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

// A link to a scheme Chromium does not handle, when not caught as a main-frame
// navigation (from an iframe, say), makes Electron ask the page's session for
// the openExternal permission and then hand the URL to the OS. openUrl decides
// instead, in every session: a <webview> guest can have a session of its own
// (omp-sidebar's partition), and its links count as its embedder's. Media
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
		if (url) openUrl(url, contents.hostWebContents ?? contents);
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
// reload the page instead of running the close-tab and reload commands; no
// item here takes a key the renderer's hotkeys use (Minimize leaves Cmd+M to
// Quick LaTeX's inline math). The Edit roles stay because text fields and
// <webview> guests undo, copy and paste through them. View keeps the default
// menu's zoom (Cmd+0, Cmd+Plus, Cmd+-), which zooms the whole app as
// Obsidian's does, and full screen. Quit closes each window through its
// before-close flush (lifecycle.ts). Windows and Linux get no menu bar.
function setApplicationMenu() {
	if (process.platform !== "darwin") return Menu.setApplicationMenu(null);
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ role: "appMenu", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }] },
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
				],
			},
			{
				label: "View",
				submenu: [
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
		]),
	);
}

// A popout window is a child window of the vault page, in the same renderer:
// the page's own code builds and drives its document, as in Obsidian. Its links
// follow the same policy as the page's, it never navigates away from its blank
// document, and it closes with the page (a reload or the vault window closing).
function setupPopout(child: BrowserWindow, opener: WebContents) {
	const contents = child.webContents;
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
	opener.once("destroyed", close);
	opener.on("did-start-navigation", onNavigation);
	child.once("closed", () => {
		if (opener.isDestroyed()) return;
		opener.off("destroyed", close);
		opener.off("did-start-navigation", onNavigation);
	});
}

function samePage(target: string, current: string) {
	try {
		const a = new URL(target);
		const b = new URL(current);
		return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
	} catch {
		return false;
	}
}

// One window per vault, by the vault folder's real path. main creates every
// window, each with its own ?vault=, in this one process and profile.
const vaultWindows = new Map<string, BrowserWindow>();

// Opens a vault's window, or brings its open window to the front.
function openVault(vault: string) {
	const key = realPathOf(vault);
	const open = vaultWindows.get(key);
	if (open) {
		if (open.isMinimized()) open.restore();
		open.focus();
		return open;
	}
	const win = new BrowserWindow({
		width: 1280,
		height: 860,
		titleBarStyle: "hiddenInset",
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
	vaultWindows.set(key, win);
	win.on("closed", () => vaultWindows.delete(key));
	const contents = win.webContents;
	remoteMain.enable(contents);
	setupWindowLifecycle(win);
	trackCliWindow(win);
	contents.setWindowOpenHandler(({ url, frameName }) => {
		if (isPopoutOpen(url, frameName)) {
			return { action: "allow", overrideBrowserWindowOptions: { minWidth: 200, minHeight: 150, titleBarStyle: "default", autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: false, sandbox: false } } };
		}
		openUrl(url, contents);
		return { action: "deny" };
	});
	contents.on("did-create-window", (child) => setupPopout(child, contents));
	// A link without a handler must not navigate the window away from the app;
	// it opens as from window.open instead. Chromium never asks about an about:
	// URL; the page cancels those navigations itself (boot.ts).
	contents.on("will-navigate", (evt) => {
		if (!evt.isMainFrame || samePage(evt.url, contents.getURL())) return;
		evt.preventDefault();
		openUrl(evt.url, contents);
	});
	contents.on("did-navigate", () => listening.delete(contents));
	win.loadFile(path.join(__dirname, "index.html"), { query: { vault } }).catch((err) => console.error("Could not load the window of", vault, err));
	return win;
}

// The first vaults come from `--vault <path>` (repeatable: `justnotes
// restart` reopens every vault window); without one the user picks a folder.
// Either way the user chose them, so links may open them from now on.
async function openFirstVaults() {
	let vaults = process.argv.flatMap((arg, i, all) => (all[i - 1] === "--vault" ? [arg] : []));
	if (!vaults.length) {
		const picked = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open vault" });
		if (picked.canceled || picked.filePaths.length === 0) return app.quit();
		vaults = [picked.filePaths[0]];
	}
	for (const vault of vaults) {
		const resolved = path.resolve(vault);
		rememberVault(resolved);
		openVault(resolved);
	}
}

remoteMain.initialize();
registerSchemes();
registerIpc();
app.whenReady().then(() => {
	handleSchemes();
	handlePermissions(session.defaultSession);
	setApplicationMenu();
	startCli(vaultWindows, openVault).catch((err) => console.error("The command line socket could not start", err));
	return openFirstVaults();
});
app.on("window-all-closed", () => app.quit());
