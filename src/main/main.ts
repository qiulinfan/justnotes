import { createRequire } from "node:module";
import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, session, shell, type WebContents } from "electron";
import { registerIpc } from "./ipc";
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
// Pages whose renderer listens for URLs; until then they wait in pendingUrls.
// A page stops listening when a new document commits (a reload).
const listening = new WeakSet<WebContents>();
const pendingUrls = process.argv.filter(isObsidianUrl);

function sendObsidianUrl(url: string, from?: WebContents) {
	const win = (from && BrowserWindow.fromWebContents(from)) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	if (win && listening.has(win.webContents)) win.webContents.send("justnotes:obsidian-url", url);
	else pendingUrls.push(url);
}

function openUrl(url: string, from: WebContents) {
	if (isObsidianUrl(url)) sendObsidianUrl(url, from);
	else void shell.openExternal(url);
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
	return pendingUrls.splice(0);
});

// A link to a scheme Chromium does not handle, when not caught as a main-frame
// navigation (from an iframe, say), makes Electron ask for the openExternal
// permission and then hand the URL to the OS. Every other permission keeps
// Electron's default (granted).
function keepObsidianLinksInApp() {
	session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
		const url = "externalURL" in details ? details.externalURL : undefined;
		if (permission === "openExternal" && url && isObsidianUrl(url)) {
			callback(false);
			sendObsidianUrl(url, contents);
		} else callback(true);
	});
}

app.on("open-url", (evt, url) => {
	evt.preventDefault();
	sendObsidianUrl(url);
});

// A <webview> guest (omp-sidebar embeds one) never gets Node or a preload
// script, and its popups open in the system browser unless the plugin installs
// its own handler through remote.
app.on("web-contents-created", (_evt, contents) => {
	contents.on("will-attach-webview", (_e, webPreferences) => {
		delete webPreferences.preload;
		webPreferences.nodeIntegration = false;
	});
	if (contents.getType() !== "webview") return;
	contents.setWindowOpenHandler(({ url }) => {
		if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
});

function samePage(target: string, current: string) {
	try {
		const a = new URL(target);
		const b = new URL(current);
		return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
	} catch {
		return false;
	}
}

// The vault comes from `--vault <path>`; without it the user picks a folder.
async function createWindow() {
	let vault = argValue("--vault");
	if (!vault) {
		const picked = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Open vault" });
		if (picked.canceled || picked.filePaths.length === 0) return app.quit();
		vault = picked.filePaths[0];
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
	const contents = win.webContents;
	remoteMain.enable(contents);
	setupWindowLifecycle(win);
	contents.setWindowOpenHandler(({ url }) => {
		openUrl(url, contents);
		return { action: "deny" };
	});
	// A link without a handler must not navigate the window away from the app.
	contents.on("will-navigate", (evt) => {
		if (!evt.isMainFrame || samePage(evt.url, contents.getURL())) return;
		evt.preventDefault();
		openUrl(evt.url, contents);
	});
	contents.on("did-navigate", () => listening.delete(contents));
	await win.loadFile(path.join(__dirname, "index.html"), { query: { vault: path.resolve(vault) } });
}

remoteMain.initialize();
registerSchemes();
registerIpc();
app.whenReady().then(() => {
	handleSchemes();
	keepObsidianLinksInApp();
	return createWindow();
});
app.on("window-all-closed", () => app.quit());
