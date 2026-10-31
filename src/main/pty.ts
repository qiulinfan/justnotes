import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
// A namespace import, so tests can load this module outside Electron.
import * as electron from "electron";
import type * as NodePty from "node-pty";

// The pseudoterminals behind the Terminal core plugin's views (see
// src/renderer/terminal). node-pty runs here in main, as VS Code runs it
// outside its windows: a reload or a crash of the page never leaves a shell
// behind, because every pty belongs to the page that started it and goes with
// that page's next navigation or its end. Popout windows have no Node; their
// terminals talk through their vault page, which owns them.

// node-pty loads from node_modules at runtime (its native binary sits beside
// its JavaScript, unpacked from the asar in the packaged app), on first use,
// so a missing binary only fails the terminals.
let ptyModule: typeof NodePty | null = null;
function nodePty() {
	ptyModule ??= createRequire(__filename)("node-pty") as typeof NodePty;
	return ptyModule;
}

export interface SpawnRequest {
	// Empty for the login shell.
	shell?: string;
	cwd: string;
	cols: number;
	rows: number;
}

export type SpawnReply = { id: number; pid: number; shell: string } | { error: string };

// The shell a terminal runs, as a terminal app starts it: the user's login
// shell (`$SHELL`, else the account's) as a login shell, or the one the
// settings name. On Windows, PowerShell, which needs no login flag.
export function shellCommand(override: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, accountShell = safeAccountShell()) {
	const chosen = override?.trim();
	if (platform === "win32") return { file: chosen || "powershell.exe", args: [] as string[] };
	const file = chosen || env.SHELL || accountShell || "/bin/zsh";
	return { file, args: ["-l"] };
}

function safeAccountShell() {
	try {
		return os.userInfo().shell ?? "";
	} catch {
		return "";
	}
}

// The environment of a shell: the app's own, as a terminal app passes it on,
// without what Electron sets for itself, and with what a terminal declares.
// A Mac app started from the Finder has no LANG, which fish and Python then
// read as ASCII; it gets the one a terminal app would set.
export function shellEnvironment(env: NodeJS.ProcessEnv, version: string, platform: NodeJS.Platform = process.platform) {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || key.startsWith("ELECTRON_") || key === "CHROME_DESKTOP" || key === "ORIGINAL_XDG_CURRENT_DESKTOP") continue;
		result[key] = value;
	}
	result.TERM = "xterm-256color";
	result.COLORTERM = "truecolor";
	result.TERM_PROGRAM = "justnotes";
	result.TERM_PROGRAM_VERSION = version;
	if (platform !== "win32" && !result.LANG && !result.LC_ALL && !result.LC_CTYPE) result.LANG = "en_US.UTF-8";
	return result;
}

// Output is held back while this much of it is still waiting for the page to
// draw (the page acknowledges what it wrote), so `cat` of a large file cannot
// pile up in the renderer; the shell is paused meanwhile, as VS Code does.
const HIGH_WATER = 100_000;
const LOW_WATER = 5_000;
// Output arriving within this many milliseconds goes to the page as one message.
const BATCH_MS = 4;

interface Session {
	id: number;
	pty: NodePty.IPty;
	owner: electron.WebContents;
	pending: string;
	timer: NodeJS.Timeout | null;
	unacknowledged: number;
	paused: boolean;
}

const sessions = new Map<number, Session>();
let nextId = 1;
// Pages whose navigation and end are watched.
const watched = new WeakSet<electron.WebContents>();

function flush(session: Session) {
	session.timer = null;
	if (!session.pending) return;
	const data = session.pending;
	session.pending = "";
	if (!session.owner.isDestroyed()) session.owner.send("justnotes:pty-data", session.id, data);
}

function kill(session: Session) {
	sessions.delete(session.id);
	if (session.timer) clearTimeout(session.timer);
	try {
		session.pty.kill();
	} catch {}
}

function killAllOf(owner: electron.WebContents) {
	for (const session of [...sessions.values()]) if (session.owner === owner) kill(session);
}

function watch(owner: electron.WebContents) {
	if (watched.has(owner)) return;
	watched.add(owner);
	owner.once("destroyed", () => killAllOf(owner));
	owner.on("did-start-navigation", (details) => {
		if (details.isMainFrame && !details.isSameDocument) killAllOf(owner);
	});
}

function spawn(owner: electron.WebContents, req: SpawnRequest): SpawnReply {
	const { file, args } = shellCommand(req.shell, process.env);
	try {
		const pty = nodePty().spawn(file, args, {
			name: "xterm-256color",
			cols: Math.max(2, Math.floor(req.cols) || 80),
			rows: Math.max(1, Math.floor(req.rows) || 24),
			cwd: req.cwd && path.isAbsolute(req.cwd) ? req.cwd : os.homedir(),
			env: shellEnvironment(process.env, electron.app.getVersion()),
		});
		const session: Session = { id: nextId++, pty, owner, pending: "", timer: null, unacknowledged: 0, paused: false };
		sessions.set(session.id, session);
		watch(owner);
		pty.onData((data) => {
			if (!sessions.has(session.id)) return;
			session.pending += data;
			session.unacknowledged += data.length;
			if (!session.paused && session.unacknowledged > HIGH_WATER) {
				session.paused = true;
				pty.pause();
			}
			session.timer ??= setTimeout(() => flush(session), BATCH_MS);
		});
		pty.onExit(({ exitCode, signal }) => {
			if (!sessions.has(session.id)) return;
			flush(session);
			sessions.delete(session.id);
			if (!owner.isDestroyed()) owner.send("justnotes:pty-exit", session.id, exitCode, signal ?? 0);
		});
		return { id: session.id, pid: pty.pid, shell: file };
	} catch (err) {
		// The message names the shell, never the environment.
		console.error("The terminal could not start", file, err instanceof Error ? err.message : err);
		return { error: `${file}: ${err instanceof Error ? err.message : String(err)}` };
	}
}

// A page reaches only the ptys it started.
function sessionOf(sender: electron.WebContents, id: number) {
	const session = sessions.get(id);
	return session?.owner === sender ? session : null;
}

export function registerPty() {
	const { ipcMain } = electron;
	ipcMain.handle("justnotes:pty-spawn", (evt, req: SpawnRequest) => spawn(evt.sender, req));
	ipcMain.on("justnotes:pty-input", (evt, id: number, data: string) => {
		if (typeof data === "string") sessionOf(evt.sender, id)?.pty.write(data);
	});
	ipcMain.on("justnotes:pty-resize", (evt, id: number, cols: number, rows: number) => {
		const session = sessionOf(evt.sender, id);
		if (!session || !(cols >= 2 && rows >= 1)) return;
		try {
			session.pty.resize(Math.floor(cols), Math.floor(rows));
		} catch {}
	});
	ipcMain.on("justnotes:pty-ack", (evt, id: number, count: number) => {
		const session = sessionOf(evt.sender, id);
		if (!session || !(count > 0)) return;
		session.unacknowledged = Math.max(0, session.unacknowledged - count);
		if (session.paused && session.unacknowledged < LOW_WATER) {
			session.paused = false;
			session.pty.resume();
		}
	});
	ipcMain.on("justnotes:pty-kill", (evt, id: number) => {
		const session = sessionOf(evt.sender, id);
		if (session) kill(session);
	});
}
