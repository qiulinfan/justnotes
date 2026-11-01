import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app, BrowserWindow, ipcMain, net } from "electron";
import { type BuildInfo, isUpdate, type LatestRelease, macSwapScript, parseRelease, windowsSwapScript, psWord } from "./update-check";

// The packaged app updates itself from the latest GitHub release, in place:
// a newer release's zip is downloaded and unpacked into the profile
// (<userData>/updates/<tag>), and once the app has quit a helper swaps it
// in where the app is installed and reopens it when the user asked to restart. Electron's
// autoUpdater (Squirrel.Mac) would need a Developer ID signature; the app is
// only ad-hoc signed. The page asks for checks (api/updates.ts): at
// start and every few hours while automatic updates are on, and from the
// command; the profile and the vaults are never touched.

const REPO = "qiulinfan/justnotes";
const AUTO_INTERVAL = 6 * 60 * 60 * 1000;

export type UpdateStatus = "unsupported" | "idle" | "checking" | "downloading" | "ready" | "current" | "error";

export interface UpdateState {
	status: UpdateStatus;
	// The release being downloaded or ready.
	tag?: string;
	error?: string;
	commit: string;
}

const build: BuildInfo = readBuildInfo();
let state: UpdateState = { status: "idle", commit: build.commit };
let staged: { tag: string; path: string } | null = null;
let running: Promise<UpdateState> | null = null;
let autoTimer: NodeJS.Timeout | null = null;
let relaunchArgs: string[] | null = null;

function readBuildInfo(): BuildInfo {
	try {
		const info = JSON.parse(fs.readFileSync(path.join(__dirname, "build-info.json"), "utf8"));
		return {
			commit: typeof info.commit === "string" ? info.commit : "",
			time: Number(info.time) || 0,
		};
	} catch {
		return { commit: "", time: 0 };
	}
}

// Where the running app is installed: the .app bundle, or the folder holding
// justnotes.exe. Null when this app cannot replace itself: run from the repo,
// another platform, or a location it may not write.
function installLocation(): string | null {
	if (!app.isPackaged) return null;
	const location = process.platform === "darwin" ? path.resolve(process.execPath, "../../..") : process.platform === "win32" ? path.dirname(process.execPath) : null;
	if (!location || (process.platform === "darwin" && !location.endsWith(".app"))) return null;
	try {
		fs.accessSync(path.dirname(location), fs.constants.W_OK);
		fs.accessSync(location, fs.constants.W_OK);
	} catch {
		return null;
	}
	// Normalize 8.3 aliases before the swap helper compares directory boundaries.
	return process.platform === "win32" ? fs.realpathSync.native(location) : location;
}

function setState(next: Omit<UpdateState, "commit">) {
	state = { ...next, commit: build.commit };
	for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("justnotes:update-state", state);
}

async function latestRelease(): Promise<LatestRelease> {
	const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
		headers: { accept: "application/vnd.github+json" },
	});
	if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
	const release = parseRelease(await res.json(), process.platform, process.arch);
	if (!release) throw new Error("GitHub's latest release could not be read");
	return release;
}

// Downloads and unpacks the release's zip; the folder it ends in holds the
// .app (macOS) or justnotes.exe (Windows). Earlier staged releases go.
async function stage(release: LatestRelease) {
	const root = path.join(app.getPath("userData"), "updates");
	const dir = path.join(root, release.tag);
	fs.rmSync(root, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	const zip = path.join(dir, release.asset!.name);
	const res = await net.fetch(release.asset!.url);
	if (!res.ok || !res.body) throw new Error(`Downloading ${release.asset!.name} failed (${res.status})`);
	await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(zip));
	const out = path.join(dir, "app");
	fs.mkdirSync(out);
	const unzip = process.platform === "darwin" ? spawnSync("ditto", ["-x", "-k", zip, out]) : spawnSync("tar", ["-xf", zip, "-C", out]);
	fs.rmSync(zip, { force: true });
	if (unzip.status !== 0) throw new Error(`${release.asset!.name} could not be unpacked`);
	const found = process.platform === "darwin" ? findIn(out, (p) => p.endsWith(".app") && fs.existsSync(path.join(p, "Contents", "MacOS", "justnotes"))) : findIn(out, (p) => fs.existsSync(path.join(p, "justnotes.exe")));
	if (!found) throw new Error(`${release.asset!.name} holds no justnotes app`);
	return process.platform === "win32" ? fs.realpathSync.native(found) : found;
}

// `dir` itself or a folder directly in it.
function findIn(dir: string, test: (p: string) => boolean) {
	if (test(dir)) return dir;
	return (
		fs
			.readdirSync(dir)
			.map((name) => path.join(dir, name))
			.find(test) ?? null
	);
}

async function check(): Promise<UpdateState> {
	if (!installLocation()) {
		setState({ status: "unsupported" });
		return state;
	}
	if (state.status === "ready") return state;
	setState({ status: "checking" });
	try {
		const release = await latestRelease();
		if (!isUpdate(build, release)) {
			setState({ status: "current" });
			return state;
		}
		setState({ status: "downloading", tag: release.tag });
		staged = { tag: release.tag, path: await stage(release) };
		setState({ status: "ready", tag: release.tag });
	} catch (err) {
		setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
	}
	return state;
}

function checkOnce() {
	running ??= check().finally(() => (running = null));
	return running;
}

// Once the app has quit (its windows flushed and closed), the staged release
// replaces it; with `relaunchArgs` set it opens again.
function applyOnQuit() {
	const location = installLocation();
	if (!staged || !location) return;
	const dir = path.dirname(staged.path);
	if (process.platform === "darwin") {
		const script = path.join(dir, "swap.sh");
		fs.writeFileSync(script, macSwapScript(process.pid, staged.path, location, relaunchArgs));
		spawn("/bin/sh", [script], { detached: true, stdio: "ignore" }).unref();
	} else {
		const script = path.join(dir, "swap.ps1");
		fs.writeFileSync(script, "\uFEFF" + `Start-Transcript -Path ${psWord(path.join(dir, "swap.log"))} -Append | Out-Null\n` + windowsSwapScript(process.pid, staged.path, location, relaunchArgs));
		const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
		// Electron's relauncher keeps the helper alive across browser-process exit.
		app.relaunch({
			execPath: powershell,
			args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script],
		});
	}
	staged = null;
}

// `restartArgs` gives the arguments a restart opens the app with (the open
// vaults; launch-args.ts).
export function registerUpdater(restartArgs: () => string[]) {
	// What the last update left (its script), or a download it never used.
	app.whenReady().then(() => fs.rmSync(path.join(app.getPath("userData"), "updates"), { recursive: true, force: true }));
	ipcMain.handle("justnotes:update-check", () => checkOnce());
	ipcMain.on("justnotes:update-state", (evt) => (evt.returnValue = state));
	// The page's "Automatic updates" setting: on, a check now and every few hours.
	ipcMain.on("justnotes:update-auto", (_evt, on: boolean) => {
		if (!on) {
			if (autoTimer) clearInterval(autoTimer);
			autoTimer = null;
		} else if (!autoTimer) {
			autoTimer = setInterval(() => void checkOnce(), AUTO_INTERVAL);
			void checkOnce();
		}
	});
	ipcMain.on("justnotes:update-restart", () => {
		if (!staged) return;
		relaunchArgs = restartArgs();
		app.quit();
	});
	app.on("will-quit", applyOnQuit);
}
