import * as fs from "node:fs";
import * as path from "node:path";

// What main reads from a launch's command line, Electron-free so tests load
// it. `args` are the arguments after the executable (from source the first is
// the checkout, which counts as any other argument).

export const isObsidianUrl = (arg: string) => /^obsidian:/i.test(arg);
// The files a launch opens: notes (Markdown, TeX) and the documents
// justnotes reads and edits itself (PDF, EPUB).
export const isDocument = (file: string) => /\.(md|markdown|tex|pdf|epub)$/i.test(file);

// The arguments `justnotes restart` relaunches with: the launch's own options
// (--profile, Electron and Chromium flags), a --vault for each vault window
// open now, and nothing the launch opened: no --vault of its own, no
// document and no obsidian: URL, which would open or run again.
export function restartArgs(args: string[], openVaults: string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--vault") {
			i++;
		} else if (arg === "--profile") {
			kept.push(...args.slice(i, i + 2));
			i++;
		} else if (!isObsidianUrl(arg) && !isDocument(arg)) {
			kept.push(arg);
		}
	}
	return [...kept, ...openVaults.flatMap((vault) => ["--vault", vault])];
}

// What a launch asks to open: the --vault folders, the documents given
// as arguments (only existing files) and the obsidian: URLs, with relative
// paths taken from the launch's working folder. A second launch on a running
// instance's profile hands its arguments over (main.ts), so they are read
// against that launch's folder, not the running instance's.
export interface LaunchRequest {
	vaults: string[];
	files: string[];
	urls: string[];
}

export function launchRequest(args: string[], cwd: string): LaunchRequest {
	const launch: LaunchRequest = { vaults: [], files: [], urls: [] };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--vault" || arg === "--profile") {
			const value = args[++i];
			if (arg === "--vault" && value) launch.vaults.push(path.resolve(cwd, value));
		} else if (isObsidianUrl(arg)) {
			launch.urls.push(arg);
		} else if (isDocument(arg) && fs.statSync(path.resolve(cwd, arg), { throwIfNoEntry: false })?.isFile()) {
			launch.files.push(path.resolve(cwd, arg));
		}
	}
	return launch;
}

// What a second launch sends the running instance with the single-instance
// lock: its arguments and working folder. Chromium may reorder or add to the
// argv it passes along on Windows, so main reads this copy when it is valid.
export interface LaunchData {
	argv: string[];
	cwd: string;
}

export function isLaunchData(value: unknown): value is LaunchData {
	const data = value as LaunchData;
	return !!data && typeof data.cwd === "string" && Array.isArray(data.argv) && data.argv.every((arg) => typeof arg === "string");
}
