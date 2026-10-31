import * as path from "node:path";
import { app, BrowserWindow, ipcMain, type WebContents } from "electron";
import { parseCliArgs } from "../cli/args";
import { type CompletionAnswer, pluginCommandList, writeCompletionCache } from "../cli/complete";
import { list, render } from "../cli/output";
import { type CliRequest, type CliResponse, cliAddress, EXIT_FAILURE, EXIT_USAGE } from "../cli/protocol";
import { BUILTINS, builtinHelp, flagsOf, type PluginCommand } from "../cli/spec";
import { pickVault } from "../cli/vaults";
import { closeCli, serveCli } from "./cli-server";
import { knownVaults, rememberVault } from "./ipc";

// Runs `justnotes <command>` requests (src/cli/justnotes.ts): main picks the
// vault, opening its window when it is not open yet, and the vault window's
// renderer runs the command (renderer/cli.ts). The few commands about windows
// and the app itself (vaults, vault:open, restart, quit) run here.

// A window takes requests once its plugins have loaded and it says so; a
// reload stops it until the new page says so again. Requests that arrive
// before wait for that, up to READY_WAIT.
const READY_WAIT = 60_000;
const ready = new WeakSet<WebContents>();
const readyWaiters = new WeakMap<WebContents, (() => void)[]>();
const pending = new Map<number, { contents: WebContents; resolve: (response: CliResponse) => void }>();
let nextId = 0;
// The plugin commands each vault's window last reported, for completion.
const reported = new Map<string, PluginCommand[]>();

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

type OpenVault = (vault: string) => BrowserWindow;

const fail = (stderr: string, code = EXIT_FAILURE): CliResponse => ({ stdout: "", stderr, code });

// After the answer has gone out.
const later = (fn: () => void) => setTimeout(fn, 200);

// The vault windows' paths, and the focused one's.
function openVaults(windows: Map<string, BrowserWindow>) {
	const focused = BrowserWindow.getFocusedWindow();
	const entries = [...windows.entries()].filter(([, win]) => !win.isDestroyed());
	return { open: entries.map(([vault]) => vault), focused: entries.find(([, win]) => win === focused)?.[0] ?? entries[0]?.[0] ?? null };
}

// The commands answered here. `lead` is the vault= the command line started
// with, if any.
async function mainCommand(windows: Map<string, BrowserWindow>, openVault: OpenVault, req: CliRequest, argv: string[], lead: string[]): Promise<CliResponse> {
	const [command, ...words] = argv;
	const spec = BUILTINS.get(command)!;
	const parsed = parseCliArgs(words, flagsOf(spec));
	if ("error" in parsed) return fail(`${parsed.error}\n${builtinHelp(spec)}`, EXIT_USAGE);
	const params = parsed.params;
	const answer = async (): Promise<CliResponse> => {
		switch (command) {
			case "vaults": {
				const { open } = openVaults(windows);
				const all = [...new Set([...knownVaults(), ...open])];
				const rows = all.map((v) => ({ name: path.basename(v), path: v, open: open.includes(v) }));
				const out = list(params, rows, { columns: params.verbose === "true" ? ["name", "path", "open"] : ["name"] });
				return { stdout: render(out, params), stderr: "", code: 0 };
			}
			case "vault:open": {
				const { open, focused } = openVaults(windows);
				const target = params.path ?? params.name;
				const picked = pickVault(target === undefined ? lead : [`vault=${target}`], req.cwd, open, knownVaults(), focused);
				if ("error" in picked) return fail(picked.error, picked.code);
				const win = await showVault(openVault, picked.vault);
				if (!win) return fail("The vault window did not finish loading.");
				return { stdout: render({ data: { vault: picked.vault }, text: picked.vault }, params), stderr: "", code: 0 };
			}
			case "restart": {
				const { open } = openVaults(windows);
				const args = process.argv.slice(1).filter((arg, i, all) => arg !== "--vault" && all[i - 1] !== "--vault");
				later(() => {
					app.relaunch({ args: [...args, ...open.flatMap((v) => ["--vault", v])] });
					app.quit();
				});
				return { stdout: render({ data: { restarting: true }, text: "Restarting justnotes." }, params), stderr: "", code: 0 };
			}
			default:
				later(() => app.quit());
				return { stdout: render({ data: { quitting: true }, text: "Quitting justnotes." }, params), stderr: "", code: 0 };
		}
	};
	return answer().catch((err) => fail(err instanceof Error ? err.message : String(err), (err as { code?: number }).code ?? EXIT_FAILURE));
}

// Opens (or focuses) a vault's window, remembering the vault as one opened on
// purpose, and waits until it takes commands.
async function showVault(openVault: OpenVault, vault: string) {
	rememberVault(vault);
	const win = openVault(vault);
	return (await whenReady(win.webContents)) ? win : null;
}

// A completion request: the vault the words name, and its plugin commands
// when a window shows it and has reported them. Nothing waits or opens.
function completionAnswer(windows: Map<string, BrowserWindow>, req: CliRequest): CliResponse {
	const { open, focused } = openVaults(windows);
	const picked = pickVault(req.argv.slice(0, 1), req.cwd, open, knownVaults(), focused);
	if ("error" in picked) return fail(picked.error, picked.code);
	const win = windows.get(picked.vault);
	const live = !!win && !win.isDestroyed() && ready.has(win.webContents);
	const answer: CompletionAnswer = { vault: picked.vault, commands: live ? (reported.get(picked.vault) ?? null) : null };
	return { stdout: JSON.stringify(answer), stderr: "", code: 0 };
}

async function dispatch(windows: Map<string, BrowserWindow>, openVault: OpenVault, req: CliRequest): Promise<CliResponse> {
	if (req.complete) return completionAnswer(windows, req);
	const lead = req.argv[0]?.startsWith("vault=") ? 1 : 0;
	if (BUILTINS.get(req.argv[lead])?.where === "main") return mainCommand(windows, openVault, req, req.argv.slice(lead), req.argv.slice(0, lead));
	const { open, focused } = openVaults(windows);
	const picked = pickVault(req.argv, req.cwd, open, knownVaults(), focused);
	if ("error" in picked) return fail(picked.error, picked.code);
	if (!picked.open && req.read) return { stdout: "", stderr: "", code: 0, unopened: picked.vault };
	let win = windows.get(picked.vault);
	if (!win || win.isDestroyed()) {
		const shown = await showVault(openVault, picked.vault);
		if (!shown) return fail("The vault window did not finish loading.");
		win = shown;
	}
	const contents = win.webContents;
	if (!(await whenReady(contents))) return fail("The vault window did not finish loading.");
	const id = ++nextId;
	return new Promise<CliResponse>((resolve) => {
		pending.set(id, { contents, resolve });
		contents.send("justnotes:cli", id, picked.argv, req.cwd);
	});
}

// Serves the profile's socket while the app runs.
export async function startCli(windows: Map<string, BrowserWindow>, openVault: OpenVault) {
	const profile = app.getPath("userData");
	// A window reports its plugin commands once it takes requests and after
	// every change (renderer/cli.ts); the cache keeps them for completion
	// while no app runs.
	ipcMain.on("justnotes:cli-handlers", (evt, commands: unknown) => {
		const vault = [...windows].find(([, win]) => !win.isDestroyed() && win.webContents === evt.sender)?.[0];
		if (!vault) return;
		const list = pluginCommandList(commands);
		reported.set(vault, list);
		try {
			writeCompletionCache(profile, vault, list);
		} catch (err) {
			console.error("Could not write the completion cache", err);
		}
	});
	const address = cliAddress(profile);
	const server = await serveCli(address, (req) => dispatch(windows, openVault, req));
	if (!server) {
		console.error("Another justnotes instance serves the command line for this profile");
		return;
	}
	app.on("will-quit", () => closeCli(server, address));
}
