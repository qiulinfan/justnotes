import * as path from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { registerIpc } from "./ipc";
import { setupWindowLifecycle } from "./lifecycle";
import { handleSchemes, registerSchemes } from "./protocol";

function argValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

// `--profile <dir>` gives this instance its own Electron user data
// (localStorage, caches), so several instances can run side by side.
const profile = argValue("--profile");
if (profile) app.setPath("userData", path.resolve(profile));

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
		},
	});
	setupWindowLifecycle(win);
	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});
	await win.loadFile(path.join(__dirname, "index.html"), { query: { vault: path.resolve(vault) } });
}

registerSchemes();
registerIpc();
app.whenReady().then(() => {
	handleSchemes();
	return createWindow();
});
app.on("window-all-closed", () => app.quit());
