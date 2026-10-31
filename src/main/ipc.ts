import { dialog, ipcMain } from "electron";

// IPC handlers the renderer calls into.
export function registerIpc() {
	ipcMain.handle("justnotes:pick-folder", async () => {
		const picked = await dialog.showOpenDialog({ properties: ["openDirectory"] });
		return picked.canceled ? null : picked.filePaths[0];
	});
	ipcMain.handle("justnotes:request-url", (_evt, req: RequestParams) => requestUrl(req));
}

interface RequestParams {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
}

// requestUrl runs here with Node's fetch, outside Chromium: no CORS, no
// browser-added Origin or Sec-Fetch headers, and headers browsers forbid
// (User-Agent, Cookie, Accept-Encoding) go out as the plugin set them.
async function requestUrl(req: RequestParams) {
	try {
		const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
		const headers: Record<string, string> = {};
		res.headers.forEach((value, name) => {
			headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
		});
		return { status: res.status, headers, body: await res.arrayBuffer() };
	} catch (err) {
		const cause = (err as { cause?: { message?: string } }).cause?.message;
		return { error: cause ?? (err instanceof Error ? err.message : String(err)) };
	}
}
