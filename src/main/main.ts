import * as path from "node:path";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

// The vault comes from `--vault <path>`; without it the user picks a folder.
function vaultFromArgs(): string | undefined {
	const i = process.argv.indexOf("--vault");
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function createWindow() {
	let vault = vaultFromArgs();
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
	win.webContents.setWindowOpenHandler(({ url }) => {
		shell.openExternal(url);
		return { action: "deny" };
	});
	await win.loadFile(path.join(__dirname, "index.html"), { query: { vault: path.resolve(vault) } });
}

ipcMain.handle("justnotes:pick-folder", async () => {
	const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
	return picked.canceled ? null : picked.filePaths[0];
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
