import * as path from "node:path";
import { BrowserWindow, nativeTheme } from "electron";

// The vault picker: a small window of the known vaults with Open folder… and
// New vault… (Obsidian's vault manager, quieter), shown when justnotes starts
// with nothing to open. Its page (src/picker/) works through the vault
// switcher's IPC (vault-switcher.ts) and closes itself once a vault opens, so
// closing it without one leaves no window and the app quits.
let picker: BrowserWindow | null = null;

export function currentVaultPicker() {
	return picker && !picker.isDestroyed() ? picker : null;
}

// `background`: a test instance's window shows without taking focus (main.ts).
export function openVaultPicker(background: boolean) {
	const open = currentVaultPicker();
	if (open) {
		open.focus();
		return open;
	}
	const win = new BrowserWindow({
		width: 440,
		height: 560,
		resizable: false,
		maximizable: false,
		fullscreenable: false,
		show: false,
		title: "justnotes",
		titleBarStyle: "hiddenInset",
		backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#f7f6f3",
		webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false },
	});
	win.once("ready-to-show", () => (background ? win.showInactive() : win.show()));
	win.on("closed", () => {
		if (picker === win) picker = null;
	});
	// The page is the app's own and opens nothing itself.
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("will-navigate", (evt) => evt.preventDefault());
	win.loadFile(path.join(__dirname, "picker.html")).catch((err) => console.error("Could not load the vault picker", err));
	picker = win;
	return win;
}
