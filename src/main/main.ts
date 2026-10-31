import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, type Session, session, shell, type WebContents } from "electron";
import { registerIpc, vaultOf } from "./ipc";
import { setupWindowLifecycle } from "./lifecycle";
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
// Schemes a link never hands to the system: file: (a note must not launch a
// local program) and schemes that run code or show the browser's or the app's
// own pages. justnotes registers no scheme of its own (protocol.ts); its page
// is file:.
const droppedSchemes = new Set(["file:", "javascript:", "data:", "blob:", "about:", "chrome:", "chrome-extension:", "devtools:", "view-source:"]);
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
// takes the URL, as Obsidian does. Resolves false when no other vault holds
// it, and the sender says it is not in this vault.
ipcMain.handle("justnotes:open-in-vault", (evt, url: string, target: string) => {
	const vault = vaultOf(target);
	if (!vault || vaultWindows.get(realPath(vault))?.webContents === evt.sender) return false;
	sendObsidianUrl(url, openVault(vault).webContents);
	return true;
});

// A link to a scheme Chromium does not handle, when not caught as a main-frame
// navigation (from an iframe, say), makes Electron ask the page's session for
// the openExternal permission and then hand the URL to the OS. openUrl decides
// instead, in every session: a <webview> guest can have a session of its own
// (omp-sidebar's partition), and its links count as its embedder's. Every
// other permission keeps Electron's default (granted).
function routeExternalLinks(ses: Session) {
	ses.setPermissionRequestHandler((contents, permission, callback, details) => {
		if (permission !== "openExternal") return callback(true);
		callback(false);
		const url = "externalURL" in details ? details.externalURL : undefined;
		if (url) openUrl(url, contents.hostWebContents ?? contents);
	});
}
app.on("session-created", routeExternalLinks);

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
// item here takes a key the renderer's hotkeys use. The Edit roles stay
// because text fields and <webview> guests undo, copy and paste through them.
// Quit closes each window through its before-close flush (lifecycle.ts).
// Windows and Linux get no menu bar.
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
			{ label: "View", submenu: [{ role: "toggleDevTools" }] },
			{ role: "window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] },
		]),
	);
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

function realPath(file: string) {
	try {
		return fs.realpathSync(file);
	} catch {
		return file;
	}
}

// Opens a vault's window, or brings its open window to the front.
function openVault(vault: string) {
	const key = realPath(vault);
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
	contents.setWindowOpenHandler(({ url }) => {
		openUrl(url, contents);
		return { action: "deny" };
	});
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

// The first vault comes from `--vault <path>`; without it the user picks a
// folder.
async function openFirstVault() {
	let vault = argValue("--vault");
	if (!vault) {
		const picked = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open vault" });
		if (picked.canceled || picked.filePaths.length === 0) return app.quit();
		vault = picked.filePaths[0];
	}
	openVault(path.resolve(vault));
}

remoteMain.initialize();
registerSchemes();
registerIpc();
app.whenReady().then(() => {
	handleSchemes();
	routeExternalLinks(session.defaultSession);
	setApplicationMenu();
	return openFirstVault();
});
app.on("window-all-closed", () => app.quit());
