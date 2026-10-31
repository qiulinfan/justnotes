import { dialog, ipcMain } from "electron";

// IPC handlers the renderer calls into.
export function registerIpc() {
	ipcMain.handle("justnotes:pick-folder", async () => {
		const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
		return picked.canceled ? null : picked.filePaths[0];
	});
}
