import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";

// Run from the repo, the app is Electron.app, whose name and icon the macOS
// menu bar and Dock show ("Electron"). A copy named justnotes, with
// justnotes' icon and an ad-hoc signature, made once per Electron version and
// icon under node_modules/.cache, fixes that. Elsewhere, or when the copy
// cannot be made, Electron runs as it is. Returns the binary to start.
export function devElectron(root: string): string {
	const require = createRequire(path.join(root, "package.json"));
	const electron = require("electron") as string;
	if (process.platform !== "darwin") return electron;
	const source = path.resolve(electron, "..", "..", "..");
	const dir = path.join(root, "node_modules", ".cache", "justnotes-dev");
	const bundle = path.join(dir, "justnotes.app");
	const binary = path.join(bundle, "Contents", "MacOS", path.basename(electron));
	const icon = path.join(root, "packaging", "icon.png");
	const stamp = path.join(dir, "stamp");
	try {
		const want = `${require("electron/package.json").version} ${fs.statSync(icon).mtimeMs}`;
		try {
			if (fs.readFileSync(stamp, "utf8") === want && fs.existsSync(binary)) return binary;
		} catch {}
		fs.rmSync(bundle, { recursive: true, force: true });
		fs.mkdirSync(dir, { recursive: true });
		// An APFS clone is instant; a plain copy where clones are unavailable.
		if (!run("cp", ["-cR", source, bundle])) run("cp", ["-R", source, bundle], true);
		const plist = path.join(bundle, "Contents", "Info.plist");
		for (const [key, value] of [
			["CFBundleName", "justnotes"],
			["CFBundleDisplayName", "justnotes"],
			["CFBundleIdentifier", "io.github.qiulinfan.justnotes.dev"],
		]) {
			run("plutil", ["-replace", key, "-string", value, plist], true);
		}
		writeIcns(icon, path.join(bundle, "Contents", "Resources", "electron.icns"));
		run("codesign", ["--force", "--deep", "--sign", "-", bundle], true);
		fs.writeFileSync(stamp, want);
		return binary;
	} catch (err) {
		console.error(`Could not make the justnotes dev app, running Electron as it is: ${err instanceof Error ? err.message : err}`);
		return electron;
	}
}

function run(command: string, args: string[], required = false) {
	const done = spawnSync(command, args, { stdio: "ignore" });
	if (required && done.status !== 0) throw new Error(`${command} ${args[0]} failed`);
	return done.status === 0;
}

// An .icns from the 1024 px PNG, through an iconset of the sizes macOS uses.
function writeIcns(png: string, icns: string) {
	const set = fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-icon-"));
	const iconset = path.join(set, "icon.iconset");
	fs.mkdirSync(iconset);
	try {
		for (const size of [16, 32, 128, 256, 512]) {
			run("sips", ["-z", String(size), String(size), png, "--out", path.join(iconset, `icon_${size}x${size}.png`)], true);
			run("sips", ["-z", String(size * 2), String(size * 2), png, "--out", path.join(iconset, `icon_${size}x${size}@2x.png`)], true);
		}
		run("iconutil", ["-c", "icns", iconset, "-o", icns], true);
	} finally {
		fs.rmSync(set, { recursive: true, force: true });
	}
}
