import { type BrowserWindow, type IpcMainEvent, ipcMain } from "electron";

// Closing a window first lets its renderer flush unsaved views, the layout and
// plugins' quit tasks. Only a renderer that has booted (and said so) is asked,
// and a renderer that never answers cannot keep the window open.
export function setupWindowLifecycle(win: BrowserWindow) {
	const contents = win.webContents;
	let handler = false;
	let closing = false;
	let allowed = false;
	const onHandler = (event: IpcMainEvent) => {
		if (event.sender === contents) handler = true;
	};
	const onReady = (event: IpcMainEvent) => {
		if (event.sender !== contents || !closing) return;
		allowed = true;
		win.close();
	};
	ipcMain.on("justnotes:close-handler", onHandler);
	ipcMain.on("justnotes:close-ready", onReady);
	// A reload drops the handler until the new page boots and registers again.
	contents.on("did-start-navigation", (details) => {
		if (details.isMainFrame && !details.isSameDocument) handler = false;
	});
	contents.on("render-process-gone", () => (handler = false));
	win.on("close", (evt) => {
		if (allowed || !handler) return;
		evt.preventDefault();
		if (closing) return;
		closing = true;
		contents.send("justnotes:before-close");
		setTimeout(() => {
			allowed = true;
			if (!win.isDestroyed()) win.close();
		}, 15000);
	});
	win.on("closed", () => {
		ipcMain.off("justnotes:close-handler", onHandler);
		ipcMain.off("justnotes:close-ready", onReady);
	});
}
