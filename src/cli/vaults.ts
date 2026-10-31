import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXIT_USAGE } from "./protocol";

// Which vault a command runs in, decided the same way by the running app
// (main/cli.ts) and by the command when no app runs (justnotes.ts). Paths
// are real paths. Electron-free, so the command can load it.

// The real path of a file that may not exist yet: its nearest existing
// folder's real path, with the rest of the path.
export function realPathOf(file: string): string {
	try {
		return fs.realpathSync(file);
	} catch {
		const parent = path.dirname(file);
		return parent === file ? file : path.join(realPathOf(parent), path.basename(file));
	}
}

// The vault that holds an absolute path, for obsidian:// URLs that name a file
// by path: the most specific of `vaults` that contains it, as Obsidian picks
// among the vaults it knows. Paths compare as real paths, so a symlinked
// spelling (/tmp for /private/tmp) finds its vault, and the file need not
// exist yet; a vault folder since moved or deleted holds nothing. Returns the
// vault's real path, or null for a relative path or one in none of them.
export function vaultOf(target: string, vaults: string[]) {
	if (!path.isAbsolute(target)) return null;
	const file = realPathOf(path.resolve(target));
	let found: string | null = null;
	for (const vault of vaults) {
		let root: string;
		try {
			root = fs.realpathSync(vault);
		} catch {
			continue;
		}
		const rel = path.relative(root, file);
		const inside = rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
		if (inside && (found === null || root.length > found.length)) found = root;
	}
	return found;
}

// The nearest folder at or above `dir` holding an Obsidian config folder,
// the mark of a vault nobody opened in justnotes yet.
export function enclosingVault(dir: string): string | null {
	let current = realPathOf(path.resolve(dir));
	for (;;) {
		try {
			if (fs.statSync(path.join(current, ".obsidian")).isDirectory()) return current;
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

// The vaults opened on purpose, kept in the profile's vaults.json (main/ipc.ts
// writes it), by real path.
export function readKnownVaults(profile: string): string[] {
	try {
		const vaults = JSON.parse(fs.readFileSync(path.join(profile, "vaults.json"), "utf8"));
		return Array.isArray(vaults) ? vaults.filter((vault) => typeof vault === "string") : [];
	} catch {
		return [];
	}
}

export type VaultPick = { vault: string; open: boolean; argv: string[] } | { error: string; code: number };

// A leading vault= names the vault by folder name (open vaults first, then
// known ones) or by path. Without it: the vault holding the folder the command
// ran in (open, known, or any folder with .obsidian above it), else
// `fallback`, the focused window's vault. `open` says whether a window shows
// it. Returns the rest of the arguments with it.
export function pickVault(argv: string[], cwd: string, open: string[], known: string[], fallback: string | null): VaultPick {
	const spec = argv[0]?.startsWith("vault=") ? argv[0].slice("vault=".length) : null;
	const rest = spec === null ? argv : argv.slice(1);
	const isOpen = (vault: string) => open.includes(vault);
	if (spec === null) {
		const here = vaultOf(cwd, open) ?? vaultOf(cwd, known) ?? enclosingVault(cwd);
		const vault = here ?? fallback;
		if (vault) return { vault, open: isOpen(vault), argv: rest };
		return { error: "No vault here: run the command inside a vault folder or give vault=<name|path>.", code: EXIT_USAGE };
	}
	if (!spec) return { error: "vault= needs a name or a path.", code: EXIT_USAGE };
	for (const list of [open, known]) {
		const named = [...new Set(list.filter((vault) => path.basename(vault) === spec))];
		if (named.length === 1) return { vault: named[0], open: isOpen(named[0]), argv: rest };
		if (named.length > 1) return { error: `Several vaults are named "${spec}"; give its path instead.`, code: EXIT_USAGE };
	}
	const expanded = spec === "~" || spec.startsWith("~/") ? path.join(os.homedir(), spec.slice(1)) : spec;
	const real = realPathOf(path.resolve(cwd, expanded));
	let folder = false;
	try {
		folder = fs.statSync(real).isDirectory();
	} catch {}
	if (folder) return { vault: real, open: isOpen(real), argv: rest };
	const names = [...new Set([...open, ...known])].map((vault) => `  ${path.basename(vault)}  ${vault}${isOpen(vault) ? "  (open)" : ""}`);
	return { error: `No vault "${spec}".${names.length ? ` Known vaults:\n${names.join("\n")}` : ""}`, code: EXIT_USAGE };
}
