import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { type CliRequest, type CliResponse, cliAddress, EXIT_FAILURE } from "../cli/protocol";
import { closeCli, pickVault, serveCli } from "./cli-server";

// Runs `justnotes <command>` requests (src/cli/justnotes.ts) in a vault
// window: main picks the window, its renderer parses the flags and calls the
// handler a plugin registered with registerCliHandler (renderer/cli.ts).

// A window takes requests once its plugins have loaded and it says so; a
// reload stops it until the new page says so again. Requests that arrive
// before wait for that, up to READY_WAIT.
const READY_WAIT = 60_000;
const ready = new WeakSet<WebContents>();
const readyWaiters = new WeakMap<WebContents, (() => void)[]>();
const pending = new Map<number, { contents: WebContents; resolve: (response: CliResponse) => void }>();
let nextId = 0;

ipcMain.on("justnotes:cli-ready", (evt) => {
	ready.add(evt.sender);
	for (const wake of readyWaiters.get(evt.sender) ?? []) wake();
	readyWaiters.delete(evt.sender);
});

ipcMain.on("justnotes:cli-result", (evt, id: number, response: CliResponse) => {
	const request = pending.get(id);
	if (!request || request.contents !== evt.sender) return;
	pending.delete(id);
	request.resolve(response);
});

// A page that goes away (reload, crash, closed window) answers its requests
// with an error instead of leaving the command waiting.
export function trackCliWindow(win: BrowserWindow) {
	const contents = win.webContents;
	const drop = (why: string) => {
		ready.delete(contents);
		for (const [id, request] of pending) {
			if (request.contents !== contents) continue;
			pending.delete(id);
			request.resolve({ stdout: "", stderr: why, code: EXIT_FAILURE });
		}
	};
	contents.on("did-start-navigation", (details) => {
		if (details.isMainFrame && !details.isSameDocument) drop("The vault window reloaded before the command finished.");
	});
	contents.on("render-process-gone", () => drop("The vault window crashed before the command finished."));
	win.on("closed", () => drop("The vault window closed before the command finished."));
}

function whenReady(contents: WebContents) {
	if (ready.has(contents)) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), READY_WAIT);
		const wake = () => {
			clearTimeout(timer);
			resolve(true);
		};
		readyWaiters.set(contents, [...(readyWaiters.get(contents) ?? []), wake]);
	});
}

async function dispatch(windows: Map<string, BrowserWindow>, req: CliRequest): Promise<CliResponse> {
	const focused = BrowserWindow.getFocusedWindow();
	const entries = [...windows.entries()];
	const fallback = entries.find(([, win]) => win === focused)?.[0] ?? entries[0]?.[0] ?? null;
	const picked = pickVault(req.argv, req.cwd, [...windows.keys()], fallback);
	if ("error" in picked) return { stdout: "", stderr: picked.error, code: picked.code };
	const win = windows.get(picked.vault);
	if (!win || win.isDestroyed()) return { stdout: "", stderr: "The vault window closed.", code: EXIT_FAILURE };
	const contents = win.webContents;
	if (!(await whenReady(contents))) return { stdout: "", stderr: "The vault window did not finish loading.", code: EXIT_FAILURE };
	const id = ++nextId;
	return new Promise<CliResponse>((resolve) => {
		pending.set(id, { contents, resolve });
		contents.send("justnotes:cli", id, picked.argv);
	});
}

// Serves the profile's socket while the app runs.
export async function startCli(windows: Map<string, BrowserWindow>) {
	const address = cliAddress(app.getPath("userData"));
	const server = await serveCli(address, (req) => dispatch(windows, req));
	if (!server) {
		console.error("Another justnotes instance serves the command line for this profile");
		return;
	}
	app.on("will-quit", () => closeCli(server, address));
}
