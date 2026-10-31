import * as fs from "node:fs";
import * as nodePath from "node:path";
import { inspect } from "node:util";
import type { App } from "../../api/app";
import { BaseDocument, BasesViewConfig, viewData } from "../../api/bases/config";
import { createBaseNote } from "../../api/bases/new-note";
import { getElectron } from "../../api/dom";
import { locateFrontmatter, removeProperty, replaceFrontmatter, setProperty } from "../../api/frontmatter-edit";
import type { Command, Hotkey } from "../../api/keymap";
import { MarkdownView } from "../../api/markdown-view";
import type { CliData } from "../../api/plugin";
import { moment, normalizePath } from "../../api/util";
import { TFile, TFolder } from "../../api/vault";
import { WorkspaceTabs, type PaneType, type WorkspaceLeaf } from "../../api/workspace";
import { dailyNote } from "../../renderer/daily-notes";
import { bookmarkUrl } from "../../renderer/bookmarks-data";
import { consoleEntries, errorEntries } from "../../renderer/dev-capture";
import { fileRecoveryOf, lineDiff, openFileRecovery, type Snapshot } from "../../renderer/file-recovery";
import { insertTemplate } from "../../renderer/templates";
import { CliError, intParam, keyValues, list, oneOf, on, type Result, type Row, result, usage } from "../output";
import { type Ctx, coreOptions, type Handler, markdown, resolveName, targetFile } from "./context";
import { baseFile, findTemplate, pickView, randomNote, resolveTemplate, savedWorkspaces } from "./vault";

// The built-in commands that need the vault window: they open things, write
// through the app (so open editors merge the change and links follow
// renames), or read state that exists only while it runs.

const sortText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function paneType(params: CliData, key = "paneType"): PaneType | false {
	if (params[key] === undefined) return false;
	return oneOf(params, key, ["tab", "split", "window"] as const, "tab");
}

// Shows the window and opens the file, as a click in the app would.
async function openFile(app: App, file: TFile, where: PaneType | false) {
	const leaf = app.workspace.getLeaf(where);
	await leaf.openFile(file, { active: true });
	showWindow();
	return leaf;
}

function showWindow() {
	const win = getElectron().remote.getCurrentWindow();
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

async function ensureFolder(app: App, path: string) {
	const parts = path.split("/").slice(0, -1);
	for (let i = 1; i <= parts.length; i++) {
		const folder = parts.slice(0, i).join("/");
		const found = app.vault.getAbstractFileByPath(folder);
		if (!found) await app.vault.createFolder(folder);
		else if (!(found instanceof TFolder)) throw new CliError(`${folder} is a file, not a folder.`);
	}
}

const withMd = (path: string) => (/\.[^/.]+$/.test(path) ? path : `${path}.md`);
const done = (data: Row, text: string): Result => ({ data, text });

// ---- General

const reload: Handler = () => {
	setTimeout(() => location.reload(), 100);
	return done({ reloading: true }, "Reloading the vault window.");
};

// ---- Files

const open: Handler = async (ctx, params) => {
	const file = targetFile(ctx, params);
	await openFile(ctx.app, file, on(params, "newtab") ? "tab" : false);
	return done({ path: file.path }, file.path);
};

// The new file's path: path= as given, name= in the folder for new notes,
// else an unused "Untitled". Notes get .md when no extension is given.
function newFilePath(app: App, params: CliData) {
	if (params.path !== undefined) return withMd(normalizePath(params.path));
	const folder = app.fileManager.getNewFileParent("");
	const base = folder.isRoot() ? "" : `${folder.path}/`;
	if (params.name !== undefined) return withMd(normalizePath(`${base}${params.name}`));
	return app.vault.getAvailablePath(`${base}Untitled`, "md");
}

const create: Handler = async (ctx, params) => {
	const { app } = ctx;
	const path = newFilePath(app, params);
	let content = params.content ?? "";
	if (params.template !== undefined) {
		const template = findTemplate(app, params.template);
		const title = nodePath.posix.basename(path).replace(/\.[^.]+$/, "");
		const text = resolveTemplate(app, await app.vault.read(template), title);
		content = content ? `${text}${text.endsWith("\n") || !text ? "" : "\n"}${content}` : text;
	}
	let file = app.vault.getAbstractFileByPath(path);
	if (file instanceof TFolder) throw new CliError(`${path} is a folder.`);
	if (file instanceof TFile) {
		if (!on(params, "overwrite")) throw new CliError(`${path} exists; add overwrite to replace it.`);
		await app.vault.modify(file, content);
	} else {
		await ensureFolder(app, path);
		file = await app.vault.create(path, content);
	}
	if (on(params, "open") || on(params, "newtab")) await openFile(app, file as TFile, on(params, "newtab") ? "tab" : false);
	return done({ path: file.path, created: true }, file.path);
};

export async function appendTo(app: App, file: TFile, content: string, inline: boolean) {
	await app.vault.process(file, (text) => (inline || !text || text.endsWith("\n") ? text + content : `${text}\n${content}`));
}

export async function prependTo(app: App, file: TFile, content: string, inline: boolean) {
	await app.vault.process(file, (text) => {
		const at = locateFrontmatter(text)?.to ?? 0;
		const gap = at > 0 && !/\r?\n$/.test(text.slice(0, at)) ? "\n" : "";
		return `${text.slice(0, at)}${gap}${content}${inline ? "" : "\n"}${text.slice(at)}`;
	});
}

const append: Handler = async (ctx, params) => {
	const file = targetFile(ctx, params);
	await appendTo(ctx.app, file, params.content, on(params, "inline"));
	return done({ path: file.path }, file.path);
};

const prepend: Handler = async (ctx, params) => {
	const file = targetFile(ctx, params);
	await prependTo(ctx.app, file, params.content, on(params, "inline"));
	return done({ path: file.path }, file.path);
};

async function moveFile(app: App, file: TFile, to: string) {
	if (to === file.path) return file.path;
	if (app.vault.getAbstractFileByPath(to)) throw new CliError(`${to} exists.`);
	await ensureFolder(app, to);
	await app.fileManager.renameFile(file, to);
	return file.path;
}

const move: Handler = async (ctx, params) => {
	const file = targetFile(ctx, params);
	const raw = normalizePath(params.to);
	const into = params.to.endsWith("/") || raw === "/" || ctx.app.vault.getAbstractFileByPath(raw) instanceof TFolder;
	const to = into ? normalizePath(`${raw === "/" ? "" : raw}/${file.name}`) : /\.[^/.]+$/.test(raw) ? raw : `${raw}.${file.extension}`;
	const from = file.path;
	return done({ from, to: await moveFile(ctx.app, file, to) }, file.path);
};

const rename: Handler = async (ctx, params) => {
	const file = targetFile(ctx, params);
	if (/[\\/]/.test(params.name) || !params.name) throw usage("name is a file name without folders; use move to change folders.");
	const name = params.name.toLowerCase().endsWith(`.${file.extension.toLowerCase()}`) ? params.name : `${params.name}.${file.extension}`;
	const to = file.parent && !file.parent.isRoot() ? `${file.parent.path}/${name}` : name;
	const from = file.path;
	return done({ from, to: await moveFile(ctx.app, file, to) }, file.path);
};

const del: Handler = async (ctx, params) => {
	const file = targetFile(ctx, params);
	const path = file.path;
	if (on(params, "permanent")) await ctx.app.vault.delete(file, true);
	else await ctx.app.vault.trash(file, ctx.app.vault.getConfig("trashOption") !== "local");
	return done({ path, deleted: true, permanent: on(params, "permanent") }, path);
};

const searchOpen: Handler = async (ctx, params) => {
	await ctx.app.internalPlugins.getPluginById("global-search")?.instance.openGlobalSearch(params.query ?? "");
	showWindow();
	return done({ query: params.query ?? "" }, "");
};

// ---- Properties

function propertyValue(raw: string, type: string): unknown {
	switch (type) {
		case "list":
		case "multitext":
		case "tags":
		case "aliases": {
			if (raw.trim().startsWith("[")) {
				try {
					const parsed = JSON.parse(raw);
					if (Array.isArray(parsed)) return parsed;
				} catch {}
			}
			return raw
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
		}
		case "number": {
			const n = Number(raw);
			if (!raw.trim() || !Number.isFinite(n)) throw usage(`"${raw}" is not a number.`);
			return n;
		}
		case "checkbox":
			if (!/^(true|false)$/i.test(raw)) throw usage(`A checkbox is true or false, not "${raw}".`);
			return raw.toLowerCase() === "true";
		case "date":
			if (!moment(raw, "YYYY-MM-DD", true).isValid()) throw usage(`A date is YYYY-MM-DD, not "${raw}".`);
			return raw;
		case "datetime":
			if (!moment(raw, ["YYYY-MM-DDTHH:mm", "YYYY-MM-DDTHH:mm:ss"], true).isValid()) throw usage(`A datetime is YYYY-MM-DDTHH:mm, not "${raw}".`);
			return raw;
		default:
			return raw;
	}
}

const TYPES = ["text", "list", "number", "checkbox", "date", "datetime"] as const;

// Rewrites only the property's lines (frontmatter-edit.ts), as editing it in
// the Properties block does.
const propertySet: Handler = async (ctx, params) => {
	const { app } = ctx;
	const file = markdown(targetFile(ctx, params));
	const types = app.metadataTypeManager;
	const fm = app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	const key = Object.keys(fm).find((k) => k.toLowerCase() === params.name.toLowerCase()) ?? params.name;
	let type: string = types.getTypeInfo(key).expected.type;
	if (params.type !== undefined) {
		type = oneOf(params, "type", TYPES, "text");
		const assigned = type === "list" ? "multitext" : type;
		if (types.getAssignedType(key) !== assigned) types.setType(key, assigned);
	}
	const value = propertyValue(params.value, type);
	await app.vault.process(file, (text) => {
		const at = locateFrontmatter(text);
		const yaml = at ? text.slice(at.yamlFrom, at.yamlTo) : "";
		const next = setProperty(yaml, key, value);
		if (at && next === yaml && JSON.stringify(fm[key]) !== JSON.stringify(value)) throw new CliError(`${file.path}'s frontmatter is not a map of properties.`);
		return replaceFrontmatter(text, next);
	});
	return done({ path: file.path, name: key, value }, `${file.path}: ${key}`);
};

const propertyRemove: Handler = async (ctx, params) => {
	const file = markdown(targetFile(ctx, params));
	const fm = ctx.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
	const key = Object.keys(fm).find((k) => k.toLowerCase() === params.name.toLowerCase());
	if (key === undefined) throw new CliError(`${file.path} has no property "${params.name}".`);
	await ctx.app.vault.process(file, (text) => {
		const at = locateFrontmatter(text);
		if (!at) return text;
		const yaml = removeProperty(text.slice(at.yamlFrom, at.yamlTo), key);
		return replaceFrontmatter(text, yaml.trim() ? yaml : "");
	});
	return done({ path: file.path, name: key }, `${file.path}: ${key}`);
};

// ---- Daily and unique notes, templates, bookmarks, bases

const daily: Handler = async (ctx, params) => {
	const file = await dailyNote(ctx.app, moment());
	await openFile(ctx.app, file, paneType(params));
	return done({ path: file.path }, file.path);
};

const dailyAdd =
	(where: "append" | "prepend"): Handler =>
	async (ctx, params) => {
		const file = await dailyNote(ctx.app, moment());
		await (where === "append" ? appendTo : prependTo)(ctx.app, file, params.content, on(params, "inline"));
		if (on(params, "open") || params.paneType !== undefined) await openFile(ctx.app, file, paneType(params));
		return done({ path: file.path }, file.path);
	};

// Obsidian's Unique note creator: zk-prefixer.json's format (default
// YYYYMMDDHHmm), folder and template.
const unique: Handler = async (ctx, params) => {
	const { app } = ctx;
	const opts = coreOptions(app, "zk-prefixer");
	const stamp = moment().format(String(opts.format || "YYYYMMDDHHmm"));
	const folder = normalizePath(String(opts.folder || "/")).replace(/^\/$/, "");
	const name = params.name ? `${stamp} ${params.name}` : stamp;
	const path = app.vault.getAvailablePath(folder ? `${folder}/${name}` : name, "md");
	let content = params.content ?? "";
	if (opts.template) {
		const template = resolveName(app, String(opts.template));
		if (!template) throw new CliError(`The unique note template "${opts.template}" was not found.`);
		const text = resolveTemplate(app, await app.vault.read(template), nodePath.posix.basename(path, ".md"));
		content = content ? `${text}${text.endsWith("\n") ? "" : "\n"}${content}` : text;
	}
	await ensureFolder(app, path);
	const file = await app.vault.create(path, content);
	if (on(params, "open") || params.paneType !== undefined) await openFile(app, file, paneType(params));
	return done({ path: file.path }, file.path);
};

const templateInsert: Handler = async (ctx, params) => {
	const view = ctx.app.workspace.getActiveViewOfType(MarkdownView);
	if (!view?.file || view.getMode() !== "source") throw new CliError("No note is being edited; open one in editing view first.");
	const template = findTemplate(ctx.app, params.name);
	await insertTemplate(ctx.app, view.editor, view.file.basename, template);
	await view.save();
	return done({ path: view.file.path, template: template.path }, view.file.path);
};

// Through the Bookmarks core plugin's addItem (Obsidian's private API), so
// the pane and bookmarks.json stay in step.
const bookmark: Handler = async (ctx, params) => {
	const instance = ctx.app.internalPlugins.getEnabledPluginById("bookmarks");
	if (typeof instance?.addItem !== "function") throw new CliError("The Bookmarks core plugin is not enabled in this vault.");
	const title = params.title;
	const targets = ["file", "folder", "search", "url"].filter((key) => params[key] !== undefined);
	if (targets.length !== 1) throw usage("Give exactly one of file=, folder=, search= or url=.");
	let item: Record<string, string>;
	if (params.file !== undefined) {
		const file = ctx.app.vault.getFileByPath(normalizePath(params.file)) ?? resolveName(ctx.app, params.file);
		if (!file) throw new CliError(`No file "${params.file}".`);
		item = { type: "file", path: file.path, ...(params.subpath ? { subpath: params.subpath.startsWith("#") ? params.subpath : `#${params.subpath}` } : {}) };
	} else if (params.folder !== undefined) {
		const folder = ctx.app.vault.getFolderByPath(normalizePath(params.folder));
		if (!folder) throw new CliError(`No folder "${params.folder}".`);
		item = { type: "folder", path: folder.path };
	} else if (params.search !== undefined) item = { type: "search", query: params.search };
	else {
		// As the Bookmark a URL dialog takes it: example.com gets https://, and
		// a URL the external-link policy drops (file:, javascript:) is refused.
		const url = bookmarkUrl(params.url);
		if (!url) throw usage(`Not a URL justnotes can open: "${params.url}".`);
		item = { type: "url", url };
	}
	if (title) item.title = title;
	await instance.addItem(item);
	return done(item, item.path ?? item.query ?? item.url ?? "");
};

const baseCreate: Handler = async (ctx, params) => {
	const base = baseFile(ctx, params);
	const doc = new BaseDocument(await ctx.app.vault.read(base));
	if (doc.error) throw new CliError(`${base.path}: ${doc.error}`);
	const { view } = pickView(doc, params.view);
	const filters = [doc.config.filters, viewData(new BasesViewConfig(view, doc.config)).filters];
	const file = await createBaseNote(ctx.app, filters, base.path, params.name ?? "Untitled", params.content ?? "");
	if (on(params, "open") || on(params, "newtab")) await openFile(ctx.app, file, on(params, "newtab") ? "tab" : false);
	return done({ path: file.path }, file.path);
};

// ---- File history (File recovery's snapshots; version 1 is the newest)

function recovery(app: App) {
	const found = fileRecoveryOf(app);
	if (!found) throw new CliError("File recovery is turned off in this vault.");
	return found;
}

// A file's path for history commands: one that no longer exists still has
// snapshots, so file=/path= also take a path from history:list.
async function historyTarget(ctx: Ctx, params: CliData) {
	try {
		return targetFile(ctx, params).path;
	} catch (err) {
		const raw = params.path ?? params.file;
		if (raw === undefined) throw err;
		const paths = await recovery(ctx.app).store.paths();
		for (const candidate of [normalizePath(raw), withMd(normalizePath(raw))]) if (paths.has(candidate)) return candidate;
		throw err;
	}
}

async function snapshots(ctx: Ctx, params: CliData) {
	const path = await historyTarget(ctx, params);
	return { path, list: await recovery(ctx.app).store.list(path) };
}

function version(list: Snapshot[], params: CliData, key: string, fallback?: number): Snapshot {
	const n = intParam(params, key, fallback ?? 0, 1);
	const found = list[n - 1];
	if (!found) throw new CliError(list.length ? `No version ${n}; there ${list.length === 1 ? "is 1" : `are ${list.length}`}.` : "The file has no snapshots.");
	return found;
}

const when = (ts: number) => moment(ts).format("YYYY-MM-DD HH:mm:ss");

const history: Handler = async (ctx, params) => {
	const { list: all } = await snapshots(ctx, params);
	const rows = all.map((s, i) => ({ version: i + 1, time: when(s.ts), size: s.data.length }));
	return list(params, rows, { columns: ["version", "time", "size"] });
};

const historyList: Handler = async (ctx, params) => {
	const paths = await recovery(ctx.app).store.paths();
	const rows = [...paths].sort(([a], [b]) => sortText(a, b)).map(([path, ts]) => ({ path, latest: when(ts), exists: !!ctx.app.vault.getFileByPath(path) }));
	return list(params, rows, { columns: ["path", "latest"] });
};

const historyRead: Handler = async (ctx, params) => {
	const { path, list: all } = await snapshots(ctx, params);
	const snapshot = version(all, params, "version", 1);
	return result({ path, time: when(snapshot.ts), content: snapshot.data }, snapshot.data);
};

const historyRestore: Handler = async (ctx, params) => {
	const { path, list: all } = await snapshots(ctx, params);
	const snapshot = version(all, params, "version");
	await recovery(ctx.app).restore(snapshot);
	return done({ path, restored: when(snapshot.ts) }, `${path}: restored the version of ${when(snapshot.ts)}`);
};

const historyOpen: Handler = async (ctx, params) => {
	recovery(ctx.app);
	const path = params.file !== undefined || params.path !== undefined ? await historyTarget(ctx, params) : (ctx.app.workspace.getActiveFile()?.path ?? null);
	openFileRecovery(ctx.app, path);
	showWindow();
	return done({ path }, path ?? "");
};

// Without from=, the versions; with it, the changes from that version to
// to= (default: the file as it is now), one line each: "+ ", "- " or "  ".
const diff: Handler = async (ctx, params) => {
	if (params.filter !== undefined && params.filter !== "local") throw usage("justnotes keeps only local snapshots (filter=local).");
	if (params.from === undefined) return history(ctx, params);
	const { path, list: all } = await snapshots(ctx, params);
	const from = version(all, params, "from");
	let after: string;
	let label: string;
	if (params.to !== undefined) {
		const to = version(all, params, "to");
		after = to.data;
		label = `version ${params.to} (${when(to.ts)})`;
	} else {
		const file = ctx.app.vault.getFileByPath(path);
		if (!file) throw new CliError(`${path} no longer exists; give to=<n>.`);
		after = await ctx.app.vault.read(file);
		label = "now";
	}
	const lines = lineDiff(from.data, after);
	const text = [`--- ${path} version ${params.from} (${when(from.ts)})`, `+++ ${path} ${label}`, ...lines.map((l) => `${l.type === "added" ? "+" : l.type === "removed" ? "-" : " "} ${l.text}`)];
	return { data: { path, lines }, text: text.join("\n") };
};

// ---- Command palette

function hotkeyText(hk: Hotkey) {
	return [...(hk.modifiers ?? []), hk.key === " " ? "Space" : hk.key.length === 1 ? hk.key.toUpperCase() : hk.key].join("+");
}

function hotkeysOf(app: App, id: string) {
	const custom = app.hotkeyManager.getHotkeys(id);
	const keys = custom ?? app.hotkeyManager.getDefaultHotkeys(id) ?? [];
	return { keys: keys.map(hotkeyText), custom: custom !== undefined };
}

const commands: Handler = (ctx, params) => {
	const prefix = params.filter ?? "";
	const rows = ctx.app.commands
		.listCommands()
		.filter((cmd) => cmd.id.startsWith(prefix))
		.sort((a, b) => sortText(a.id, b.id))
		.map((cmd) => ({ id: cmd.id, name: cmd.name, hotkey: hotkeysOf(ctx.app, cmd.id).keys.join(", ") }));
	return list(params, rows, { columns: on(params, "verbose") ? ["id", "name", "hotkey"] : ["id"] });
};

// id= exactly; name= as the palette shows it, ignoring case, or the one
// command whose name contains it.
function findCommand(app: App, params: CliData): Command {
	if (params.id !== undefined) {
		const cmd = app.commands.findCommand(params.id);
		if (!cmd) throw new CliError(`No command "${params.id}". Run "justnotes commands" for the list.`);
		return cmd;
	}
	if (params.name === undefined) throw usage("Give id=<command-id> or name=<name>.");
	const wanted = params.name.toLowerCase();
	const all = app.commands.listCommands();
	const exact = all.filter((cmd) => cmd.name.toLowerCase() === wanted);
	const matches = exact.length ? exact : all.filter((cmd) => cmd.name.toLowerCase().includes(wanted));
	if (matches.length === 1) return matches[0];
	if (!matches.length) throw new CliError(`No command named "${params.name}".`);
	const names = matches.slice(0, 20).map((cmd) => `  ${cmd.id}  ${cmd.name}`);
	throw new CliError(`"${params.name}" names ${matches.length} commands; give one's id:\n${names.join("\n")}`);
}

const command: Handler = (ctx, params) => {
	const cmd = findCommand(ctx.app, params);
	if (!ctx.app.commands.executeCommand(cmd)) throw new CliError(`${cmd.id} cannot run now (it may need an open note or another view).`);
	return done({ id: cmd.id, name: cmd.name }, `Executed ${cmd.id}`);
};

const hotkeys: Handler = (ctx, params) => {
	const { hotkeyManager } = ctx.app;
	const ids = new Set([...Object.keys(hotkeyManager.defaultKeys), ...Object.keys(hotkeyManager.customKeys)]);
	const rows = [...ids]
		.filter((id) => ctx.app.commands.findCommand(id))
		.sort(sortText)
		.map((id) => ({ id, ...hotkeysOf(ctx.app, id) }))
		.filter((row) => row.keys.length)
		.map((row) => ({ id: row.id, hotkey: row.keys.join(", "), custom: row.custom }));
	return list(params, rows, { columns: on(params, "verbose") ? ["id", "hotkey", "custom"] : ["id", "hotkey"] });
};

const hotkey: Handler = (ctx, params) => {
	if (!ctx.app.commands.findCommand(params.id)) throw new CliError(`No command "${params.id}".`);
	const { keys, custom } = hotkeysOf(ctx.app, params.id);
	const text = keys.join(", ") + (on(params, "verbose") && keys.length ? `  (${custom ? "custom" : "default"})` : "");
	return { data: { id: params.id, hotkeys: keys, custom }, text };
};

// ---- Plugins

interface PluginRow extends Row {
	id: string;
	name: string;
	type: "core" | "community";
	version: string;
	enabled: boolean;
}

function pluginRows(app: App): PluginRow[] {
	const community = Object.values(app.plugins.manifests).map((m) => ({ id: m.id, name: m.name, type: "community" as const, version: m.version ?? "", enabled: !!app.plugins.plugins[m.id] }));
	const core = Object.values(app.internalPlugins.plugins).map((p) => ({ id: p.id, name: p.id, type: "core" as const, version: "", enabled: p.enabled }));
	return [...core, ...community].sort((a, b) => sortText(a.id, b.id));
}

const pluginList =
	(enabledOnly: boolean): Handler =>
	(ctx, params) => {
		const filter = params.filter === undefined ? null : oneOf(params, "filter", ["core", "community"] as const, "community");
		const rows = pluginRows(ctx.app).filter((p) => (!filter || p.type === filter) && (!enabledOnly || p.enabled));
		return list(params, rows, { columns: on(params, "versions") ? ["id", "version"] : ["id"] });
	};

function communityPlugin(app: App, params: CliData) {
	if (params.filter === "core" || (app.internalPlugins.getPluginById(params.id) && !app.plugins.manifests[params.id])) {
		throw new CliError("Core plugins follow the vault's core-plugins.json, which justnotes never writes; turn them on or off in Obsidian.");
	}
	const manifest = app.plugins.manifests[params.id];
	if (!manifest) throw new CliError(`No community plugin "${params.id}" is installed.`);
	return manifest;
}

const plugin: Handler = (ctx, params) => {
	const core = ctx.app.internalPlugins.getPluginById(params.id);
	const manifest = ctx.app.plugins.manifests[params.id];
	if (manifest) {
		const { id, name, version: v, author, description, minAppVersion, dir } = manifest as typeof manifest & Record<string, string>;
		return keyValues({ id, name, type: "community", version: v, author, description, minAppVersion, dir, enabled: !!ctx.app.plugins.plugins[id] });
	}
	if (core) return keyValues({ id: core.id, type: "core", enabled: core.enabled });
	throw new CliError(`No plugin "${params.id}".`);
};

const pluginEnable: Handler = async (ctx, params) => {
	const manifest = communityPlugin(ctx.app, params);
	if (!(await ctx.app.plugins.enablePluginAndSave(manifest.id))) throw new CliError(`${manifest.id} could not be enabled; see dev:errors.`);
	return done({ id: manifest.id, enabled: true }, `Enabled ${manifest.id}`);
};

const pluginDisable: Handler = async (ctx, params) => {
	const manifest = communityPlugin(ctx.app, params);
	await ctx.app.plugins.disablePluginAndSave(manifest.id);
	return done({ id: manifest.id, enabled: false }, `Disabled ${manifest.id}`);
};

// Reads the manifest and main.js again, as a developer's reload does.
const pluginReload: Handler = async (ctx, params) => {
	const manifest = communityPlugin(ctx.app, params);
	if (!ctx.app.plugins.plugins[manifest.id]) throw new CliError(`${manifest.id} is not enabled.`);
	await ctx.app.plugins.disablePlugin(manifest.id);
	if (manifest.dir) await ctx.app.plugins.loadManifest(manifest.dir);
	if (!(await ctx.app.plugins.enablePlugin(manifest.id))) throw new CliError(`${manifest.id} failed to load again; see dev:errors.`);
	return done({ id: manifest.id, reloaded: true }, `Reloaded ${manifest.id}`);
};

// To the system trash, or the vault's .trash when trashOption says local, as
// deleted notes go.
async function trashConfigFolder(app: App, path: string) {
	const adapter = app.vault.adapter;
	if (app.vault.getConfig("trashOption") === "local") await adapter.trashLocal(path);
	else if (!(await adapter.trashSystem(path))) throw new CliError(`${path} could not be moved to the trash.`);
}

const pluginUninstall: Handler = async (ctx, params) => {
	const manifest = communityPlugin(ctx.app, params);
	await ctx.app.plugins.disablePluginAndSave(manifest.id);
	if (manifest.dir) await trashConfigFolder(ctx.app, manifest.dir);
	delete ctx.app.plugins.manifests[manifest.id];
	return done({ id: manifest.id, uninstalled: true }, `Moved ${manifest.dir} to the trash.`);
};

// ---- Themes and snippets

const themes: Handler = (ctx, params) => {
	const css = ctx.app.customCss;
	const rows = Object.entries(css.themes)
		.map(([name, info]) => ({ name, version: info.version ?? "", active: name === css.theme }))
		.sort((a, b) => sortText(a.name, b.name));
	return list(params, rows, { columns: on(params, "versions") ? ["name", "version"] : ["name"] });
};

function knownTheme(app: App, name: string) {
	if (!app.customCss.themes[name]) throw new CliError(`No theme "${name}" is installed.`);
	return app.customCss.themes[name];
}

const theme: Handler = (ctx, params) => {
	if (params.name === undefined) return result({ theme: ctx.app.customCss.theme }, ctx.app.customCss.theme || "(default)");
	const info = knownTheme(ctx.app, params.name);
	return keyValues({ name: params.name, version: info.version ?? "", author: info.author ?? "", active: ctx.app.customCss.theme === params.name });
};

const themeSet: Handler = (ctx, params) => {
	if (params.name) knownTheme(ctx.app, params.name);
	ctx.app.customCss.setTheme(params.name);
	return done({ theme: params.name }, params.name || "(default)");
};

const themeUninstall: Handler = async (ctx, params) => {
	knownTheme(ctx.app, params.name);
	if (ctx.app.customCss.theme === params.name) ctx.app.customCss.setTheme("");
	await trashConfigFolder(ctx.app, ctx.app.customCss.getThemeFolder() + `/${params.name}`);
	await ctx.app.customCss.readThemes();
	return done({ theme: params.name, uninstalled: true }, `Moved ${params.name} to the trash.`);
};

const snippetList =
	(enabledOnly: boolean): Handler =>
	(ctx, params) => {
		const css = ctx.app.customCss;
		const rows = css.snippets.filter((name) => !enabledOnly || css.enabledSnippets.has(name)).map((name) => ({ name, enabled: css.enabledSnippets.has(name) }));
		return list(params, rows, { columns: ["name"] });
	};

const snippetToggle =
	(enabled: boolean): Handler =>
	(ctx, params) => {
		if (!ctx.app.customCss.snippets.includes(params.name)) throw new CliError(`No snippet "${params.name}" in ${ctx.app.customCss.getSnippetsFolder()}.`);
		ctx.app.customCss.setCssEnabledStatus(params.name, enabled);
		return done({ name: params.name, enabled }, `${enabled ? "Enabled" : "Disabled"} ${params.name}`);
	};

// ---- Random notes and the workspace

const random: Handler = async (ctx, params) => {
	const file = randomNote(ctx, params);
	await openFile(ctx.app, file, on(params, "newtab") ? "tab" : false);
	return done({ path: file.path }, file.path);
};

interface LayoutNode {
	id?: string;
	type: string;
	direction?: string;
	children?: LayoutNode[];
	state?: { type?: string; state?: { file?: string } };
}

function layoutLines(node: LayoutNode, depth: number, ids: boolean, out: string[]) {
	const pad = "  ".repeat(depth);
	const id = ids && node.id ? ` [${node.id}]` : "";
	if (node.type === "leaf") {
		const file = node.state?.state?.file;
		out.push(`${pad}${node.state?.type ?? "empty"}${file ? `: ${file}` : ""}${id}`);
		return;
	}
	out.push(`${pad}${node.type}${node.direction ? ` (${node.direction})` : ""}${id}`);
	for (const child of node.children ?? []) layoutLines(child, depth + 1, ids, out);
}

const workspace: Handler = (ctx, params) => {
	const layout = ctx.app.workspace.getLayout() as Record<string, unknown>;
	const out: string[] = [];
	for (const key of ["main", "left", "right", "floating"]) {
		const node = layout[key] as LayoutNode | undefined;
		if (!node) continue;
		out.push(`${key}:`);
		layoutLines(node, 1, on(params, "ids"), out);
	}
	return { data: layout, text: out.join("\n") };
};

function leafRow(leaf: WorkspaceLeaf): Row {
	const file = (leaf.view as { file?: TFile | null }).file;
	return { id: leaf.id, type: leaf.view.getViewType(), title: leaf.getDisplayText(), path: file?.path ?? "", group: leaf.parent?.id ?? "" };
}

const tabs: Handler = (ctx, params) => {
	const rows: Row[] = [];
	ctx.app.workspace.iterateRootLeaves((leaf) => {
		rows.push(leafRow(leaf));
	});
	return list(params, rows, { columns: on(params, "ids") ? ["id", "type", "title"] : ["type", "title"] });
};

const tabOpen: Handler = async (ctx, params) => {
	const { workspace: ws } = ctx.app;
	let leaf: WorkspaceLeaf;
	if (params.group !== undefined) {
		let group: WorkspaceTabs | null = null;
		ws.iterateAllLeaves((l) => {
			if (!group && l.parent instanceof WorkspaceTabs && l.parent.id === params.group) group = l.parent;
		});
		if (!group) throw new CliError(`No tab group "${params.group}"; see tabs ids.`);
		leaf = ws.createLeafInParent(group, (group as WorkspaceTabs).children.length);
	} else leaf = ws.getLeaf("tab");
	if (params.file !== undefined) {
		const file = ctx.app.vault.getFileByPath(normalizePath(params.file)) ?? resolveName(ctx.app, params.file);
		if (!file) throw new CliError(`No file "${params.file}".`);
		await leaf.openFile(file, { active: true });
	} else await leaf.setViewState({ type: params.view ?? "empty", active: true });
	ws.setActiveLeaf(leaf, { focus: true });
	showWindow();
	return done(leafRow(leaf), leaf.id);
};

const recents: Handler = (ctx, params) => list(params, ctx.app.workspace.getLastOpenFiles().map((path) => ({ path })), { columns: ["path"] });

const workspaceLoad: Handler = async (ctx, params) => {
	const { workspaces: saved } = await savedWorkspaces(ctx.app);
	const layout = saved[params.name];
	if (!layout) throw new CliError(`No workspace "${params.name}" in workspaces.json.`);
	await ctx.app.workspace.changeLayout(layout);
	return done({ name: params.name }, params.name);
};

// ---- Developer

const evaluate: Handler = async (_ctx, params) => {
	// Indirect eval: the code sees the window's globals (app, require), not this module.
	let value: unknown = (0, eval)(params.code);
	if (value instanceof Promise) value = await value;
	const text = value === undefined ? "" : typeof value === "string" ? value : inspect(value, { depth: 4 });
	let data: unknown;
	try {
		data = value === undefined ? null : JSON.parse(JSON.stringify(value));
	} catch {
		data = text;
	}
	return { data, text };
};

function webContents() {
	return getElectron().remote.getCurrentWebContents();
}

const devtools: Handler = () => {
	const wc = webContents();
	wc.toggleDevTools();
	return done({ open: !wc.isDevToolsOpened() }, "");
};

const devDebug: Handler = (_ctx, params) => {
	const dbg = webContents().debugger;
	if (on(params, "on") && !dbg.isAttached()) dbg.attach("1.3");
	if (on(params, "off") && dbg.isAttached()) dbg.detach();
	return done({ attached: dbg.isAttached() }, dbg.isAttached() ? "attached" : "detached");
};

const devCdp: Handler = async (_ctx, params) => {
	let args: object | undefined;
	if (params.params !== undefined) {
		try {
			args = JSON.parse(params.params);
		} catch {
			throw usage("params must be JSON.");
		}
	}
	const dbg = webContents().debugger;
	const attached = dbg.isAttached();
	if (!attached) dbg.attach("1.3");
	try {
		const answer = await dbg.sendCommand(params.method, args);
		return result(answer, JSON.stringify(answer, null, 2));
	} finally {
		if (!attached) dbg.detach();
	}
};

const entryLine = (e: { level: string; time: number; text: string }) => `${moment(e.time).format("HH:mm:ss.SSS")} [${e.level}] ${e.text}`;

const devErrors: Handler = (_ctx, params) => {
	const entries = [...errorEntries];
	if (on(params, "clear")) errorEntries.length = 0;
	return { data: entries, text: entries.map(entryLine).join("\n") };
};

const devConsole: Handler = (_ctx, params) => {
	const limit = intParam(params, "limit", 50, 1);
	const level = params.level === undefined ? null : oneOf(params, "level", ["log", "warn", "error", "info", "debug"] as const, "log");
	const entries = consoleEntries.filter((e) => !level || e.level === level).slice(-limit);
	if (on(params, "clear")) consoleEntries.length = 0;
	return { data: entries, text: entries.map(entryLine).join("\n") };
};

const devScreenshot: Handler = async (ctx, params) => {
	const image = await webContents().capturePage();
	const png = image.toPNG();
	if (params.path === undefined) {
		const base64 = png.toString("base64");
		return result({ base64 }, base64);
	}
	const out = nodePath.resolve(ctx.cwd, params.path);
	await fs.promises.writeFile(out, png);
	return done({ path: out, bytes: png.length }, out);
};

function sheetSource(sheet: CSSStyleSheet) {
	if (sheet.href) return sheet.href.replace(/^.*\//, "");
	const owner = sheet.ownerNode as HTMLElement | null;
	if (!owner) return "(constructed)";
	const attrs = ["data-plugin", "data-justnotes", "id"].map((a) => owner.getAttribute?.(a)).find(Boolean);
	return attrs ? `<style ${attrs}>` : `<${owner.nodeName.toLowerCase()}>`;
}

// The rules that apply to the first element matching the selector, in
// stylesheet order, each with its stylesheet and position in it.
const devCss: Handler = (_ctx, params) => {
	const el = document.querySelector(params.selector);
	if (!el) throw new CliError(`Nothing matches "${params.selector}".`);
	const rows: Row[] = [];
	const visit = (rules: CSSRuleList, source: string, media: string) => {
		for (let i = 0; i < rules.length; i++) {
			const rule = rules[i];
			if (rule instanceof CSSStyleRule) {
				let matches = false;
				try {
					matches = el.matches(rule.selectorText);
				} catch {}
				if (!matches) continue;
				const decls: string[] = [];
				for (let d = 0; d < rule.style.length; d++) {
					const prop = rule.style[d];
					if (params.prop && prop !== params.prop) continue;
					decls.push(`${prop}: ${rule.style.getPropertyValue(prop)}${rule.style.getPropertyPriority(prop) ? " !important" : ""}`);
				}
				if (decls.length) rows.push({ source: `${source} #${i}`, media, selector: rule.selectorText, declarations: decls });
			} else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) {
				const cond = rule instanceof CSSMediaRule ? rule.conditionText : "";
				visit((rule as CSSGroupingRule).cssRules, source, cond || media);
			}
		}
	};
	for (const sheet of Array.from(document.styleSheets)) {
		try {
			visit(sheet.cssRules, sheetSource(sheet), "");
		} catch {}
	}
	const text = rows.map((r) => `${r.source}${r.media ? ` @media ${r.media}` : ""}\n${r.selector} {\n${(r.declarations as string[]).map((d) => `  ${d};`).join("\n")}\n}`).join("\n\n");
	return { data: rows, text };
};

const devDom: Handler = (_ctx, params) => {
	let found: Element[];
	try {
		found = Array.from(document.querySelectorAll(params.selector));
	} catch {
		throw usage(`"${params.selector}" is not a CSS selector.`);
	}
	if (on(params, "total")) return result(found.length, String(found.length));
	const picked = on(params, "all") ? found : found.slice(0, 1);
	if (!picked.length) throw new CliError(`Nothing matches "${params.selector}".`);
	const values = picked.map((el) => {
		if (params.attr !== undefined) return el.getAttribute(params.attr) ?? "";
		if (params.css !== undefined) return getComputedStyle(el).getPropertyValue(params.css);
		if (on(params, "text")) return el.textContent ?? "";
		return on(params, "inner") ? el.innerHTML : el.outerHTML;
	});
	return { data: on(params, "all") ? values : values[0], text: values.join("\n") };
};

export const APP_COMMANDS: Record<string, Handler> = {
	reload,
	open,
	create,
	append,
	prepend,
	move,
	rename,
	delete: del,
	"search:open": searchOpen,
	"property:set": propertySet,
	"property:remove": propertyRemove,
	daily,
	"daily:append": dailyAdd("append"),
	"daily:prepend": dailyAdd("prepend"),
	unique,
	"template:insert": templateInsert,
	bookmark,
	"base:create": baseCreate,
	diff,
	history,
	"history:list": historyList,
	"history:read": historyRead,
	"history:restore": historyRestore,
	"history:open": historyOpen,
	commands,
	command,
	hotkeys,
	hotkey,
	plugins: pluginList(false),
	"plugins:enabled": pluginList(true),
	"plugins:restrict": () => done({ restricted: false }, "off"),
	plugin,
	"plugin:enable": pluginEnable,
	"plugin:disable": pluginDisable,
	"plugin:reload": pluginReload,
	"plugin:uninstall": pluginUninstall,
	themes,
	theme,
	"theme:set": themeSet,
	"theme:uninstall": themeUninstall,
	snippets: snippetList(false),
	"snippets:enabled": snippetList(true),
	"snippet:enable": snippetToggle(true),
	"snippet:disable": snippetToggle(false),
	random,
	workspace,
	tabs,
	"tab:open": tabOpen,
	recents,
	"workspace:load": workspaceLoad,
	eval: evaluate,
	devtools,
	"dev:debug": devDebug,
	"dev:cdp": devCdp,
	"dev:errors": devErrors,
	"dev:console": devConsole,
	"dev:screenshot": devScreenshot,
	"dev:css": devCss,
	"dev:dom": devDom,
};
