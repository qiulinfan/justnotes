import type { App } from "../../api/app";
import type { CliData } from "../../api/plugin";
import { isNoteExtension } from "../../api/note-files";
import { normalizePath } from "../../api/util";
import { TFile, TFolder } from "../../api/vault";
import { CliError, NeedsApp, type Result, usage } from "../output";

// What a built-in command runs against. In the vault window `app` is the
// real App and `live` is true. With no app running, the command builds a
// headless one (offline.ts) holding only the vault, its metadata cache, the
// property types and the core plugins' options: `live` is false, and
// anything needing more throws NeedsApp.
export interface Ctx {
	app: App;
	live: boolean;
	version: string;
	// The folder the command ran in; paths outside the vault resolve from it.
	cwd: string;
}

export type Handler = (ctx: Ctx, params: CliData) => Result | Promise<Result>;

export function needsLive(ctx: Ctx, why: string, hint = "") {
	if (!ctx.live) throw new NeedsApp(why, hint);
}

export function activeFile(ctx: Ctx): TFile {
	needsLive(ctx, "the active file", "give file=<name> or path=<path>");
	const file = ctx.app.workspace.getActiveFile();
	if (!file) throw new CliError("No file is active; give file=<name> or path=<path>.");
	return file;
}

// file=<name> resolves like a wikilink (a full path also works), path=<path>
// is exact; with neither, the active file.
export function targetFile(ctx: Ctx, params: CliData, key = "file"): TFile {
	const { vault, metadataCache } = ctx.app;
	if (params.path !== undefined) {
		const file = vault.getFileByPath(normalizePath(params.path));
		if (!file) throw new CliError(`No file at "${params.path}".`);
		return file;
	}
	const name = params[key];
	if (name === undefined) return activeFile(ctx);
	const file = resolveName(ctx.app, name);
	if (!file) throw new CliError(`No file named "${name}".`);
	return file;
}

export function resolveName(app: App, name: string): TFile | null {
	const path = normalizePath(name);
	return app.metadataCache.getFirstLinkpathDest(path.replace(/#.*$/, ""), "") ?? app.vault.getFileByPath(path);
}

export function folderParam(ctx: Ctx, params: CliData, key: string): TFolder | null {
	const raw = params[key];
	if (raw === undefined || raw === "" || raw === "/") return null;
	const folder = ctx.app.vault.getFolderByPath(normalizePath(raw));
	if (!folder) throw new CliError(`No folder at "${raw}".`);
	return folder;
}

export function inFolder(path: string, folder: TFolder | null) {
	return !folder || folder.isRoot() || path.startsWith(`${folder.path}/`);
}

// A note of any kind: Markdown, TeX or text (api/note-files.ts).
export function note(file: TFile) {
	if (!isNoteExtension(file.extension)) throw usage(`${file.path} is not a note (Markdown, TeX or text).`);
	return file;
}

export function markdown(file: TFile) {
	if (file.extension !== "md") throw usage(`${file.path} is not a Markdown note.`);
	return file;
}

export function coreOptions(app: App, id: string): Record<string, any> {
	return app.internalPlugins.getPluginById(id)?.instance.options ?? {};
}

export async function readConfigJson(app: App, name: string): Promise<any> {
	try {
		return JSON.parse(await app.vault.adapter.read(`${app.vault.configDir}/${name}`));
	} catch {
		return null;
	}
}
