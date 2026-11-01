// `bun scripts/install.ts`: installs justnotes on this machine and links its
// command onto PATH (~/.local/bin). macOS builds the checkout and installs
// /Applications/justnotes.app; Windows installs the latest release CI made
// from main into %LOCALAPPDATA%\Programs\justnotes, keeping the previous
// install as justnotes.previous. Either refuses while the installed app runs,
// so open notes are never cut off; quit it, install, and open it again.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const REPO = "qiulinfan/justnotes";
const bin = path.join(os.homedir(), ".local", "bin");

function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
	const result = spawnSync(cmd, args, { cwd: opts.cwd ?? root, stdio: "inherit" });
	if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed`);
}

function output(cmd: string, args: string[]) {
	return spawnSync(cmd, args, { encoding: "utf8" }).stdout ?? "";
}

// A link (or, on Windows, a .cmd shim) at ~/.local/bin/<name> for the
// installed command, replacing an earlier one but never a real program.
function linkCommand(name: string, target: string, shim: boolean) {
	fs.mkdirSync(bin, { recursive: true });
	const at = path.join(bin, name);
	const st = fs.lstatSync(at, { throwIfNoEntry: false });
	if (shim) {
		if (st && !fs.readFileSync(at, "utf8").includes("justnotes")) throw new Error(`${at} exists and is not justnotes' command`);
		fs.writeFileSync(at, `@echo off\r\n"${target}" %*\r\n`);
	} else {
		if (st && !st.isSymbolicLink()) throw new Error(`${at} exists and is not a link`);
		if (st) fs.rmSync(at);
		fs.symlinkSync(target, at);
	}
	console.log(`${at} -> ${target}`);
}

function installMac() {
	const app = "/Applications/justnotes.app";
	// Anchored, so a shell whose command line merely names the app is not taken for it.
	if (output("pgrep", ["-f", `^${app}/Contents/MacOS/justnotes`]).trim()) throw new Error("justnotes is running from /Applications: quit it first");
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	run("bun", ["scripts/dist.ts", "--mac", "--dir", `--${arch}`]);
	const built = path.join(root, "release", arch === "arm64" ? "mac-arm64" : "mac", "justnotes.app");
	if (!fs.existsSync(path.join(built, "Contents", "MacOS", "justnotes"))) throw new Error(`No app at ${built}`);
	// Copied beside the old app, then swapped in by rename, so a failed copy
	// leaves the installed app as it was.
	const next = "/Applications/.justnotes.app.new";
	const old = "/Applications/.justnotes.app.old";
	fs.rmSync(next, { recursive: true, force: true });
	fs.rmSync(old, { recursive: true, force: true });
	run("ditto", [built, next]);
	if (fs.existsSync(app)) fs.renameSync(app, old);
	fs.renameSync(next, app);
	fs.rmSync(old, { recursive: true, force: true });
	// Launch Services learns the new bundle's document types (md, tex) now.
	run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", app]);
	console.log(`Installed ${app}`);
	linkCommand("justnotes", `${app}/Contents/Resources/cli/justnotes`, false);
}

async function installWindows() {
	const home = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Programs");
	const dir = path.join(home, "justnotes");
	if (output("tasklist", ["/FI", "IMAGENAME eq justnotes.exe", "/NH"]).includes("justnotes.exe")) throw new Error("justnotes is running: quit it first");
	const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
	if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest release`);
	const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
	const asset = release.assets.find((a) => /-win-x64\.zip$/.test(a.name));
	if (!asset) throw new Error(`Release ${release.tag_name} has no Windows zip`);
	const downloads = path.join(os.homedir(), "Downloads", `justnotes-${release.tag_name}`);
	const zip = path.join(downloads, asset.name);
	const staged = path.join(downloads, "app");
	fs.mkdirSync(downloads, { recursive: true });
	if (!fs.existsSync(zip)) {
		const file = await fetch(asset.browser_download_url);
		if (!file.ok) throw new Error(`Downloading ${asset.name} failed (${file.status})`);
		await Bun.write(zip, file);
	}
	fs.rmSync(staged, { recursive: true, force: true });
	fs.mkdirSync(staged, { recursive: true });
	run("tar", ["-xf", zip, "-C", staged]);
	// The zip holds the app folder's contents, or that folder itself.
	const appDir = fs.existsSync(path.join(staged, "justnotes.exe"))
		? staged
		: fs
				.readdirSync(staged)
				.map((name) => path.join(staged, name))
				.find((p) => fs.existsSync(path.join(p, "justnotes.exe")));
	if (!appDir) throw new Error(`${asset.name} holds no justnotes.exe`);
	const previous = path.join(home, "justnotes.previous");
	fs.rmSync(previous, { recursive: true, force: true });
	if (fs.existsSync(dir)) fs.renameSync(dir, previous);
	try {
		fs.renameSync(appDir, dir);
	} catch (err) {
		if (fs.existsSync(previous)) fs.renameSync(previous, dir);
		throw err;
	}
	console.log(`Installed ${release.tag_name} in ${dir} (the last install is ${previous})`);
	linkCommand("justnotes.cmd", path.join(dir, "resources", "cli", "justnotes.cmd"), true);
}

if (process.platform === "darwin") installMac();
else if (process.platform === "win32") await installWindows();
else throw new Error("justnotes installs on macOS and Windows");
