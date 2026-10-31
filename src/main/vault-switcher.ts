import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// A namespace import, so tests can load this module outside Electron.
import * as electron from "electron";
import { forgetVault, knownVaults, realPathOf, rememberVault } from "./ipc";

// The vault switcher at the bottom of the left sidebar and its Manage vaults
// dialog (renderer/vault-switcher.ts) ask main for the known vaults (the
// profile's vaults.json, plus any open window's) and open, add, create and
// forget them here. A vault opens or comes to the front through the same
// openVault as the command's vault:open and obsidian:// links. Removing a
// vault from the list never touches its folder.

// One vault as the switcher lists it. `label` is the folder name, with the
// folder above it (home as ~) where two vaults share a name; `shortPath` the
// folder with home as ~.
export interface VaultRow {
	path: string;
	shortPath: string;
	name: string;
	label: string;
	open: boolean;
	current: boolean;
	missing: boolean;
}

// What an add or create reports: the vault opened, nothing (cancelled), or
// why not.
export type VaultResult = { vault: string } | { error: string } | null;

export function tildePath(dir: string, home = os.homedir()) {
	const rel = path.relative(home, dir);
	if (rel === "") return "~";
	return rel.startsWith("..") || path.isAbsolute(rel) ? dir : path.join("~", rel);
}

// Known and open vaults, by real path, once each, sorted by name (then
// path). `current` is the asking window's vault. A known folder since moved
// or deleted is `missing`.
export function vaultRows(known: string[], open: string[], current: string | null, exists: (dir: string) => boolean): VaultRow[] {
	const paths = [...new Set([...known, ...open])];
	const count = new Map<string, number>();
	for (const vault of paths) count.set(path.basename(vault), (count.get(path.basename(vault)) ?? 0) + 1);
	const rows = paths.map((vault) => {
		const name = path.basename(vault) || vault;
		const label = (count.get(path.basename(vault)) ?? 0) > 1 ? `${name} (${tildePath(path.dirname(vault))})` : name;
		return { path: vault, shortPath: tildePath(vault), name, label, open: open.includes(vault), current: vault === current, missing: !exists(vault) };
	});
	return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.path.localeCompare(b.path));
}

// Why `name` cannot be a new vault's folder name, or null. One plain path
// segment: no separator, not hidden (a dot folder would hide the vault the
// way .obsidian is hidden), no characters Windows or Obsidian's own file
// names refuse.
export function vaultNameProblem(name: string): string | null {
	const trimmed = name.trim();
	if (!trimmed) return "Enter a name for the vault.";
	if (trimmed !== name) return "The name cannot start or end with a space.";
	if (/[\\/:*?"<>|]/.test(name)) return 'The name cannot contain any of \\ / : * ? " < > |.';
	if (name.startsWith(".")) return "The name cannot start with a dot.";
	if (name.endsWith(".")) return "The name cannot end with a dot.";
	return null;
}

// Why `folder` cannot open as a vault, or null: it must be an existing
// folder, not the file system's root and not inside a vault's .obsidian
// folder (plugin code and settings, never a vault of its own).
export function vaultFolderProblem(folder: string): string | null {
	if (!path.isAbsolute(folder)) return "Not an absolute path.";
	let stat: fs.Stats;
	try {
		stat = fs.statSync(folder);
	} catch {
		return `${folder} does not exist.`;
	}
	if (!stat.isDirectory()) return `${folder} is not a folder.`;
	const real = realPathOf(folder);
	if (path.dirname(real) === real) return "The root of a disk cannot be a vault.";
	if (real.split(path.sep).includes(".obsidian")) return `${folder} is inside a vault's .obsidian folder.`;
	return null;
}

// Makes the folder of a new vault, `name` in `parent`, and nothing in it
// (Obsidian's config folder comes when the vault's settings are first
// written). Returns its real path, or why it could not.
export function createVaultFolder(parent: string, name: string): { vault: string } | { error: string } {
	const problem = vaultNameProblem(name) ?? vaultFolderProblem(parent);
	if (problem) return { error: problem };
	const vault = path.join(realPathOf(parent), name);
	try {
		fs.mkdirSync(vault);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EEXIST") return { error: `${tildePath(parent)} already has a "${name}".` };
		return { error: err instanceof Error ? err.message : String(err) };
	}
	return { vault: realPathOf(vault) };
}

// Asks before a folder justnotes has not opened becomes a vault, because its
// window runs the vault's community plugins. True to go on.
export async function confirmUnknownVault(vault: string, detail: string, parent?: electron.BrowserWindow | null) {
	const options: electron.MessageBoxOptions = {
		type: "question",
		buttons: ["Open", "Cancel"],
		defaultId: 0,
		cancelId: 1,
		message: `Open "${path.basename(vault)}" as a vault?`,
		detail: `${detail} Opening the folder ${vault} runs the community plugins it has enabled.`,
	};
	const { response } = parent ? await electron.dialog.showMessageBox(parent, options) : await electron.dialog.showMessageBox(options);
	return response === 0;
}

const isFolder = (dir: string) => {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
};

// The IPC behind the switcher. `windows` are the vault windows by real path,
// `openVault` opens or focuses one.
export function registerVaultSwitcher(windows: Map<string, electron.BrowserWindow>, openVault: (vault: string) => electron.BrowserWindow) {
	const { ipcMain, shell, dialog, BrowserWindow } = electron;
	const senderWindow = (sender: electron.WebContents) => BrowserWindow.fromWebContents(sender);
	const known = () => knownVaults().map(realPathOf);
	const openPaths = () => [...windows.entries()].filter(([, win]) => !win.isDestroyed()).map(([vault]) => vault);
	const vaultOfSender = (sender: electron.WebContents) => [...windows.entries()].find(([, win]) => !win.isDestroyed() && win.webContents === sender)?.[0] ?? null;
	// Only a listed vault: the page never names an arbitrary folder to open.
	const listed = (vault: unknown) => {
		if (typeof vault !== "string" || !path.isAbsolute(vault)) return null;
		const real = realPathOf(vault);
		return known().includes(real) || openPaths().includes(real) ? real : null;
	};
	const pickFolder = async (sender: electron.WebContents, title: string, buttonLabel: string) => {
		const win = senderWindow(sender);
		const options: electron.OpenDialogOptions = { properties: ["openDirectory", "createDirectory"], title, buttonLabel };
		const picked = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
		return picked.canceled || !picked.filePaths.length ? null : picked.filePaths[0];
	};

	ipcMain.handle("justnotes:vaults", (evt): VaultRow[] => vaultRows(known(), openPaths(), vaultOfSender(evt.sender), isFolder));

	ipcMain.handle("justnotes:switch-vault", (_evt, vault: unknown) => {
		const real = listed(vault);
		if (!real || !isFolder(real)) return false;
		openVault(real);
		return true;
	});

	// "Open folder as vault": the picked folder itself, confirmed first when
	// justnotes has not opened it before.
	ipcMain.handle("justnotes:open-folder-as-vault", async (evt): Promise<VaultResult> => {
		const folder = await pickFolder(evt.sender, "Open folder as vault", "Open");
		if (!folder) return null;
		const problem = vaultFolderProblem(folder);
		if (problem) return { error: problem };
		const vault = realPathOf(folder);
		if (!known().includes(vault) && !openPaths().includes(vault)) {
			if (!(await confirmUnknownVault(vault, "justnotes has not opened this folder before.", senderWindow(evt.sender)))) return null;
		}
		rememberVault(vault);
		openVault(vault);
		return { vault };
	});

	ipcMain.handle("justnotes:pick-vault-location", (evt) => pickFolder(evt.sender, "Location of the new vault", "Choose"));

	// A new vault is an empty folder the user named, so it has no plugins to
	// confirm.
	ipcMain.handle("justnotes:create-vault", (_evt, parent: unknown, name: unknown): VaultResult => {
		if (typeof parent !== "string" || typeof name !== "string") return { error: "Choose a location and a name." };
		const made = createVaultFolder(parent, name);
		if ("error" in made) return made;
		rememberVault(made.vault);
		openVault(made.vault);
		return made;
	});

	ipcMain.handle("justnotes:reveal-vault", (_evt, vault: unknown) => {
		const real = listed(vault);
		if (!real || !isFolder(real)) return false;
		shell.showItemInFolder(real);
		return true;
	});

	// An open vault stays listed while its window shows it.
	ipcMain.handle("justnotes:forget-vault", (_evt, vault: unknown) => {
		const real = listed(vault);
		if (!real || openPaths().includes(real)) return false;
		forgetVault(real);
		return true;
	});
}
