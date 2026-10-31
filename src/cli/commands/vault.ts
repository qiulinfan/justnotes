import type { App } from "../../api/app";
import { BaseDocument, BasesViewConfig } from "../../api/bases/config";
import { QueryRun } from "../../api/bases/entry";
import { viewTable } from "../../api/bases/export";
import { executeQuery } from "../../api/bases/query";
import type { CachedMetadata } from "../../api/metadata";
import { getAllTags, parseFrontMatterAliases } from "../../api/metadata-utils";
import type { CliData } from "../../api/plugin";
import { apiVersion, moment, normalizePath } from "../../api/util";
import { TFile, TFolder } from "../../api/vault";
import { dailyNotePathIn } from "../../renderer/daily-notes";
import { compileSearch, isTag, type SearchMatch, tagMatches, tagQuery, textMatches } from "../../renderer/search";
import { fillTemplate, findTemplatesFolder, templateFiles, dateFormat, timeFormat } from "../../renderer/templates";
import { countWords } from "../../renderer/word-count";
import { CliError, intParam, keyValues, list, oneOf, on, type Row, result, usage } from "../output";
import { type Ctx, folderParam, type Handler, inFolder, markdown, needsLive, readConfigJson, resolveName, targetFile } from "./context";

// The built-in commands that only read the vault: they run in the vault
// window, and with no app running against the headless app (offline.ts).

const sortPaths = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

function cacheOf(app: App, file: TFile): CachedMetadata | null {
	return app.metadataCache.getFileCache(file);
}

// ---- Files and folders

function fileInfo(file: TFile): Row {
	return { path: file.path, name: file.basename, extension: file.extension, size: file.stat.size, created: Math.round(file.stat.ctime), modified: Math.round(file.stat.mtime) };
}

function folderStats(folder: TFolder) {
	let files = 0;
	let folders = 0;
	let size = 0;
	const walk = (f: TFolder) => {
		for (const child of f.children) {
			if (child instanceof TFolder) {
				folders++;
				walk(child);
			} else if (child instanceof TFile) {
				files++;
				size += child.stat.size;
			}
		}
	};
	walk(folder);
	return { files, folders, size };
}

const file: Handler = (ctx, params) => keyValues(fileInfo(targetFile(ctx, params)));

const files: Handler = (ctx, params) => {
	const folder = folderParam(ctx, params, "folder");
	const ext = params.ext?.replace(/^\./, "").toLowerCase();
	const rows = ctx.app.vault
		.getFiles()
		.filter((f) => inFolder(f.path, folder) && (!ext || f.extension.toLowerCase() === ext))
		.map((f) => f.path)
		.sort(sortPaths)
		.map((path) => ({ path }));
	return list(params, rows, { columns: ["path"] });
};

const folder: Handler = (ctx, params) => {
	const path = normalizePath(params.path);
	const found = path === "/" ? ctx.app.vault.getRoot() : ctx.app.vault.getFolderByPath(path);
	if (!found) throw new CliError(`No folder at "${params.path}".`);
	const stats = folderStats(found);
	if (params.info !== undefined) {
		const key = oneOf(params, "info", ["files", "folders", "size"] as const, "files");
		return result(stats[key], String(stats[key]));
	}
	return keyValues({ path: found.path, ...stats });
};

const folders: Handler = (ctx, params) => {
	const parent = folderParam(ctx, params, "folder");
	const rows = ctx.app.vault
		.getAllFolders(false)
		.filter((f) => inFolder(f.path, parent))
		.map((f) => f.path)
		.sort(sortPaths)
		.map((path) => ({ path }));
	return list(params, rows, { columns: ["path"] });
};

const read: Handler = async (ctx, params) => {
	const target = targetFile(ctx, params);
	const content = await ctx.app.vault.read(target);
	return result({ path: target.path, content }, content);
};

// ---- Search

interface Hit {
	file: TFile;
	matches: SearchMatch[];
	lines: string[];
}

// Full-text search like the Search pane: text, /regex/, or tag:#tag through
// the metadata cache; a file name hit counts as a match.
async function search(ctx: Ctx, params: CliData): Promise<Hit[]> {
	const query = params.query.trim();
	if (!query) throw usage("query must not be empty.");
	const folder = folderParam(ctx, params, "path");
	const limit = intParam(params, "limit", Number.POSITIVE_INFINITY, 1);
	const tag = tagQuery(query);
	const re = tag === null ? compileSearch(query, on(params, "case") ? true : false) : null;
	if (tag === null && !re) throw usage("Invalid regular expression.");
	const nameRe = re && new RegExp(re.source, re.flags.replace("g", ""));
	const { vault, metadataCache } = ctx.app;
	const hits: Hit[] = [];
	const all = vault
		.getMarkdownFiles()
		.filter((f) => inFolder(f.path, folder))
		.sort((a, b) => sortPaths(a.path, b.path));
	for (const f of all) {
		const cache = tag === null ? null : metadataCache.getFileCache(f);
		if (tag !== null && !getAllTags(cache)?.some((name) => isTag(name, tag))) continue;
		const text = await vault.cachedRead(f);
		const found = tag !== null ? tagMatches(cache, text, tag) : textMatches(text, re!);
		if (!found.length && !(nameRe && f.basename.search(nameRe) >= 0) && tag === null) continue;
		hits.push({ file: f, matches: found, lines: text.split("\n") });
		if (hits.length >= limit) break;
	}
	return hits;
}

const searchFiles: Handler = async (ctx, params) => {
	const hits = await search(ctx, params);
	if (on(params, "total")) return result({ total: hits.length }, String(hits.length));
	oneOf(params, "format", ["text", "json"] as const, "text");
	const rows = hits.map((h) => ({ path: h.file.path, matches: h.matches.length }));
	return { data: rows, text: rows.map((r) => r.path).join("\n") };
};

const searchContext: Handler = async (ctx, params) => {
	oneOf(params, "format", ["text", "json"] as const, "text");
	const hits = await search(ctx, params);
	const rows = hits.flatMap((h) => h.matches.map((m) => ({ path: h.file.path, line: m.line + 1, text: h.lines[m.line] ?? "" })));
	return { data: rows, text: rows.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n") };
};

// ---- Links and graph

const linkFiles = (app: App) => app.vault.getFiles();

const backlinks: Handler = (ctx, params) => {
	const target = targetFile(ctx, params);
	const rows: Row[] = [];
	for (const [source, links] of Object.entries(ctx.app.metadataCache.resolvedLinks)) {
		const count = links[target.path];
		if (count && source !== target.path) rows.push({ path: source, count });
	}
	rows.sort((a, b) => sortPaths(String(a.path), String(b.path)));
	return list(params, rows, { columns: on(params, "counts") ? ["path", "count"] : ["path"] });
};

const links: Handler = (ctx, params) => {
	const source = targetFile(ctx, params);
	const { resolvedLinks, unresolvedLinks } = ctx.app.metadataCache;
	const rows: Row[] = [
		...Object.entries(resolvedLinks[source.path] ?? {}).map(([path, count]) => ({ path, resolved: true, count })),
		...Object.entries(unresolvedLinks[source.path] ?? {}).map(([path, count]) => ({ path, resolved: false, count })),
	];
	return list(params, rows, { columns: ["path"] });
};

const unresolved: Handler = (ctx, params) => {
	const byLink = new Map<string, { count: number; sources: string[] }>();
	for (const [source, links] of Object.entries(ctx.app.metadataCache.unresolvedLinks)) {
		for (const [link, count] of Object.entries(links)) {
			const entry = byLink.get(link) ?? { count: 0, sources: [] };
			entry.count += count;
			entry.sources.push(source);
			byLink.set(link, entry);
		}
	}
	const rows = [...byLink]
		.sort(([a], [b]) => sortPaths(a, b))
		.map(([link, { count, sources }]) => ({ link, count, sources: sources.sort(sortPaths) }));
	const columns = ["link", ...(on(params, "counts") ? ["count"] : []), ...(on(params, "verbose") ? ["sources"] : [])];
	return list(params, rows, { columns });
};

const orphans: Handler = (ctx, params) => {
	const linked = new Set<string>();
	for (const [source, targets] of Object.entries(ctx.app.metadataCache.resolvedLinks)) {
		for (const target of Object.keys(targets)) if (target !== source) linked.add(target);
	}
	const rows = linkFiles(ctx.app)
		.map((f) => f.path)
		.filter((path) => !linked.has(path))
		.sort(sortPaths)
		.map((path) => ({ path }));
	return list(params, rows, { columns: ["path"] });
};

const deadends: Handler = (ctx, params) => {
	const { resolvedLinks, unresolvedLinks } = ctx.app.metadataCache;
	const has = (record: Record<string, Record<string, number>>, path: string) => Object.keys(record[path] ?? {}).length > 0;
	const rows = ctx.app.vault
		.getMarkdownFiles()
		.map((f) => f.path)
		.filter((path) => !has(resolvedLinks, path) && !has(unresolvedLinks, path))
		.sort(sortPaths)
		.map((path) => ({ path }));
	return list(params, rows, { columns: ["path"] });
};

// The local graph's nodes: notes up to `depth` links away, following
// outgoing links, backlinks or both, each with its distance.
const neighbours: Handler = (ctx, params) => {
	const start = targetFile(ctx, params);
	const depth = intParam(params, "depth", 1, 1);
	const direction = oneOf(params, "direction", ["both", "out", "in"] as const, "both");
	const withUnresolved = on(params, "unresolved");
	const { resolvedLinks, unresolvedLinks } = ctx.app.metadataCache;
	const incoming = new Map<string, Set<string>>();
	for (const [source, targets] of Object.entries(resolvedLinks)) {
		for (const target of Object.keys(targets)) {
			if (!incoming.has(target)) incoming.set(target, new Set());
			incoming.get(target)!.add(source);
		}
	}
	const seen = new Map<string, { distance: number; resolved: boolean }>([[start.path, { distance: 0, resolved: true }]]);
	let frontier = [start.path];
	for (let d = 1; d <= depth && frontier.length; d++) {
		const next: string[] = [];
		const visit = (path: string, resolved: boolean) => {
			if (seen.has(path)) return;
			seen.set(path, { distance: d, resolved });
			if (resolved) next.push(path);
		};
		for (const path of frontier) {
			if (direction !== "in") {
				for (const target of Object.keys(resolvedLinks[path] ?? {})) visit(target, true);
				if (withUnresolved) for (const link of Object.keys(unresolvedLinks[path] ?? {})) visit(link, false);
			}
			if (direction !== "out") for (const source of incoming.get(path) ?? []) visit(source, true);
		}
		frontier = next;
	}
	seen.delete(start.path);
	const rows = [...seen]
		.sort(([a, x], [b, y]) => x.distance - y.distance || sortPaths(a, b))
		.map(([path, { distance, resolved }]) => ({ path, distance, resolved }));
	return list(params, rows, { columns: ["path", "distance"] });
};

// ---- Outline and word count

const outline: Handler = (ctx, params) => {
	const target = markdown(targetFile(ctx, params));
	const headings = (cacheOf(ctx.app, target)?.headings ?? []).map((h) => ({ heading: h.heading, level: h.level, line: h.position.start.line + 1 }));
	if (on(params, "total")) return result({ total: headings.length }, String(headings.length));
	const format = params.json === "true" ? "json" : oneOf(params, "format", ["tree", "md", "json"] as const, "tree");
	if (format === "md") return { data: headings, text: headings.map((h) => `${"#".repeat(h.level)} ${h.heading}`).join("\n") };
	const top = Math.min(...headings.map((h) => h.level));
	return { data: headings, text: headings.map((h) => `${"  ".repeat(h.level - top)}${h.heading}`).join("\n") };
};

const wordcount: Handler = async (ctx, params) => {
	const target = targetFile(ctx, params);
	const counts = countWords(await ctx.app.vault.cachedRead(target));
	if (on(params, "words")) return result(counts.words, String(counts.words));
	if (on(params, "characters")) return result(counts.characters, String(counts.characters));
	return keyValues({ path: target.path, ...counts });
};

// ---- Tags

function fileTags(app: App, f: TFile) {
	const seen = new Map<string, string>();
	for (const tag of getAllTags(cacheOf(app, f)) ?? []) {
		const name = tag.startsWith("#") ? tag : `#${tag}`;
		if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
	}
	return [...seen.values()];
}

function wantsOneFile(params: CliData) {
	return params.file !== undefined || params.path !== undefined || on(params, "active");
}

const tags: Handler = (ctx, params) => {
	const sort = oneOf(params, "sort", ["name", "count"] as const, "name");
	const counted = new Map<string, { tag: string; count: number }>();
	const scope = wantsOneFile(params) ? [markdown(targetFile(ctx, params))] : ctx.app.vault.getMarkdownFiles();
	for (const f of scope) {
		for (const tag of fileTags(ctx.app, f)) {
			const entry = counted.get(tag.toLowerCase()) ?? { tag, count: 0 };
			entry.count++;
			counted.set(tag.toLowerCase(), entry);
		}
	}
	const rows = [...counted.values()].sort((a, b) => (sort === "count" ? b.count - a.count : 0) || sortPaths(a.tag, b.tag));
	return list(params, rows, { columns: on(params, "counts") ? ["tag", "count"] : ["tag"] });
};

const tag: Handler = (ctx, params) => {
	const name = params.name.replace(/^#/, "").toLowerCase();
	if (!name) throw usage("name must not be empty.");
	const notes = ctx.app.vault
		.getMarkdownFiles()
		.filter((f) => fileTags(ctx.app, f).some((t) => isTag(t, name)))
		.map((f) => f.path)
		.sort(sortPaths);
	const data = { tag: `#${name}`, count: notes.length, files: notes };
	if (on(params, "total")) return result(notes.length, String(notes.length));
	return { data, text: on(params, "verbose") ? [`#${name}  ${notes.length}`, ...notes].join("\n") : `#${name}  ${notes.length}` };
};

// ---- Tasks

const TASK_LINE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\]\s?)(.*)$/;

interface Task extends Row {
	path: string;
	line: number;
	status: string;
	text: string;
}

async function tasksOf(app: App, f: TFile): Promise<Task[]> {
	const items = cacheOf(app, f)?.listItems?.filter((item) => item.task !== undefined) ?? [];
	if (!items.length) return [];
	const lines = (await app.vault.cachedRead(f)).split(/\r?\n/);
	return items.flatMap((item) => {
		const line = item.position.start.line;
		const m = TASK_LINE.exec(lines[line] ?? "");
		return m ? [{ path: f.path, line: line + 1, status: m[2], text: m[4] }] : [];
	});
}

function dailyFile(app: App): TFile {
	const path = dailyNotePathIn(app, moment());
	const found = app.vault.getFileByPath(path);
	if (!found) throw new CliError(`Today's daily note (${path}) does not exist yet.`);
	return found;
}

const isDone = (status: string) => status === "x" || status === "X";
const taskLine = (t: Row) => `- [${t.status}] ${t.text}`;

const tasks: Handler = async (ctx, params) => {
	const scope = on(params, "daily") ? [dailyFile(ctx.app)] : wantsOneFile(params) ? [markdown(targetFile(ctx, params))] : ctx.app.vault.getMarkdownFiles();
	scope.sort((a, b) => sortPaths(a.path, b.path));
	let found = (await Promise.all(scope.map((f) => tasksOf(ctx.app, f)))).flat();
	if (params.status !== undefined) found = found.filter((t) => t.status === params.status);
	if (on(params, "done")) found = found.filter((t) => isDone(t.status));
	if (on(params, "todo")) found = found.filter((t) => t.status === " ");
	const out = list(params, found, { columns: ["path", "line", "status", "text"], format: "text", formats: ["tsv", "csv", "md", "yaml"], text: taskLine });
	if (on(params, "verbose") && (params.format ?? "text") === "text" && !on(params, "total") && params.json !== "true") {
		const lines: string[] = [];
		let last = "";
		for (const t of found) {
			if (t.path !== last) lines.push(...(last ? [""] : []), t.path);
			last = t.path;
			lines.push(`  ${t.line}: ${taskLine(t)}`);
		}
		out.text = lines.join("\n");
	}
	return out;
};

// Shows a task, or sets its status character in place (the rest of the line
// keeps its bytes).
const task: Handler = async (ctx, params) => {
	let target: TFile;
	let line: number;
	if (params.ref !== undefined) {
		const m = /^(.*):(\d+)$/.exec(params.ref);
		if (!m) throw usage("ref must be path:line.");
		target = ctx.app.vault.getFileByPath(normalizePath(m[1])) ?? resolveName(ctx.app, m[1]) ?? (() => {
			throw new CliError(`No file "${m[1]}".`);
		})();
		line = Number(m[2]);
	} else {
		target = on(params, "daily") ? dailyFile(ctx.app) : targetFile(ctx, params);
		if (params.line === undefined) throw usage("Give ref=<path:line>, or line=<n> with file=, path= or daily.");
		line = intParam(params, "line", 1, 1);
	}
	const lines = (await ctx.app.vault.cachedRead(target)).split(/\r?\n/);
	const m = TASK_LINE.exec(lines[line - 1] ?? "");
	if (!m) throw new CliError(`Line ${line} of ${target.path} is not a task.`);
	let status: string | null = null;
	if (params.status !== undefined) {
		if ([...params.status].length !== 1) throw usage("status must be one character.");
		status = params.status;
	} else if (on(params, "toggle")) status = m[2] === " " ? "x" : " ";
	else if (on(params, "done")) status = "x";
	else if (on(params, "todo")) status = " ";
	if (status !== null && status !== m[2]) {
		needsLive(ctx, "changing a task");
		await ctx.app.vault.process(target, (text) => {
			const all = text.split("\n");
			const current = TASK_LINE.exec(all[line - 1]?.replace(/\r$/, "") ?? "");
			if (!current) throw new CliError(`Line ${line} of ${target.path} is no longer a task.`);
			all[line - 1] = all[line - 1].replace(TASK_LINE, (_all, a: string, _s: string, b: string, rest: string) => `${a}${status}${b}${rest}`);
			return all.join("\n");
		});
	}
	const shown: Task = { path: target.path, line, status: status ?? m[2], text: m[4] };
	return { data: shown, text: `${shown.path}:${shown.line}: ${taskLine(shown)}` };
};

// ---- Properties

function frontmatterOf(app: App, f: TFile): Record<string, unknown> {
	const fm = cacheOf(app, f)?.frontmatter;
	return fm && typeof fm === "object" ? (fm as Record<string, unknown>) : {};
}

const properties: Handler = (ctx, params) => {
	const sort = oneOf(params, "sort", ["name", "count"] as const, "name");
	const types = ctx.app.metadataTypeManager;
	let rows: Row[];
	if (wantsOneFile(params)) {
		const target = markdown(targetFile(ctx, params));
		const fm = frontmatterOf(ctx.app, target);
		if (params.total === "true") return result({ total: Object.keys(fm).length }, String(Object.keys(fm).length));
		const format = params.json === "true" ? "json" : oneOf(params, "format", ["yaml", "json", "tsv", "csv", "md"] as const, "yaml");
		if (format === "yaml" || format === "json") return result(fm);
		rows = Object.entries(fm).map(([name, value]) => ({ name, value }));
		return list(params, rows, { columns: ["name", "value"], formats: ["tsv", "csv", "md"] });
	}
	const counted = new Map<string, { name: string; type: string; count: number }>();
	for (const f of ctx.app.vault.getMarkdownFiles()) {
		for (const name of Object.keys(frontmatterOf(ctx.app, f))) {
			const entry = counted.get(name.toLowerCase()) ?? { name, type: types.getTypeInfo(name).expected.type, count: 0 };
			entry.count++;
			counted.set(name.toLowerCase(), entry);
		}
	}
	if (params.name !== undefined) {
		const entry = counted.get(params.name.toLowerCase());
		const count = entry?.count ?? 0;
		return result({ name: entry?.name ?? params.name, type: entry?.type ?? types.getTypeInfo(params.name).expected.type, count }, String(count));
	}
	rows = [...counted.values()].sort((a, b) => (sort === "count" ? b.count - a.count : 0) || sortPaths(a.name, b.name));
	if (params.total === "true") return result({ total: rows.length }, String(rows.length));
	const format = params.json === "true" ? "json" : oneOf(params, "format", ["yaml", "json", "tsv", "csv", "md"] as const, "yaml");
	const counts = on(params, "counts");
	if (format === "yaml") {
		return { data: rows, text: rows.map((r) => `${r.name}: ${r.type}${counts ? `  # ${r.count}` : ""}`).join("\n") };
	}
	return list(params, rows, { columns: counts ? ["name", "type", "count"] : ["name", "type"], formats: ["tsv", "csv", "md"] });
};

const propertyRead: Handler = (ctx, params) => {
	const target = markdown(targetFile(ctx, params));
	const fm = frontmatterOf(ctx.app, target);
	const key = Object.keys(fm).find((k) => k.toLowerCase() === params.name.toLowerCase());
	if (key === undefined) throw new CliError(`${target.path} has no property "${params.name}".`);
	const value = fm[key];
	return result(value ?? null, value == null ? "" : Array.isArray(value) ? value.map(String).join("\n") : typeof value === "object" ? JSON.stringify(value) : String(value));
};

const aliases: Handler = (ctx, params) => {
	const scope = wantsOneFile(params) ? [markdown(targetFile(ctx, params))] : ctx.app.vault.getMarkdownFiles();
	const rows = scope
		.flatMap((f) => (parseFrontMatterAliases(frontmatterOf(ctx.app, f)) ?? []).map((alias) => ({ alias, path: f.path })))
		.sort((a, b) => sortPaths(a.alias, b.alias) || sortPaths(a.path, b.path));
	return list(params, rows, { columns: on(params, "verbose") ? ["alias", "path"] : ["alias"] });
};

// ---- Daily notes and templates

const dailyPath: Handler = (ctx) => {
	const path = dailyNotePathIn(ctx.app, moment());
	return result({ path, exists: !!ctx.app.vault.getFileByPath(path) }, path);
};

const dailyRead: Handler = async (ctx) => {
	const f = dailyFile(ctx.app);
	const content = await ctx.app.vault.read(f);
	return result({ path: f.path, content }, content);
};

function templatesFolder(app: App) {
	const folder = findTemplatesFolder(app);
	if (typeof folder === "string") throw new CliError(folder);
	return folder;
}

function templateName(folder: TFolder, f: TFile) {
	return f.path.slice(folder.isRoot() ? 0 : folder.path.length + 1, -3);
}

export function findTemplate(app: App, name: string): TFile {
	const folder = templatesFolder(app);
	const all = templateFiles(folder);
	const wanted = normalizePath(name).replace(/\.md$/, "").toLowerCase();
	const found = all.find((f) => templateName(folder, f).toLowerCase() === wanted) ?? all.find((f) => f.basename.toLowerCase() === wanted);
	if (!found) throw new CliError(`No template "${name}" in ${folder.path}.`);
	return found;
}

export function resolveTemplate(app: App, text: string, title: string) {
	return fillTemplate(text, { title, date: moment(), dateFormat: dateFormat(app), timeFormat: timeFormat(app) });
}

const templates: Handler = (ctx, params) => {
	const folder = templatesFolder(ctx.app);
	const rows = templateFiles(folder)
		.map((f) => ({ name: templateName(folder, f), path: f.path }))
		.sort((a, b) => sortPaths(a.name, b.name));
	return list(params, rows, { columns: ["name"] });
};

const templateRead: Handler = async (ctx, params) => {
	const f = findTemplate(ctx.app, params.name);
	let content = await ctx.app.vault.read(f);
	if (on(params, "resolve")) content = resolveTemplate(ctx.app, content, params.title ?? f.basename);
	return result({ path: f.path, content }, content);
};

// ---- Bookmarks (bookmarks.json, Obsidian's format)

interface BookmarkItem {
	type?: string;
	title?: string;
	path?: string;
	subpath?: string;
	query?: string;
	url?: string;
	items?: BookmarkItem[];
}

const bookmarks: Handler = async (ctx, params) => {
	const data = await readConfigJson(ctx.app, "bookmarks.json");
	const rows: Row[] = [];
	const walk = (items: BookmarkItem[] | undefined, group: string) => {
		for (const item of items ?? []) {
			if (!item || typeof item !== "object") continue;
			if (item.type === "group") {
				walk(item.items, group ? `${group}/${item.title ?? ""}` : (item.title ?? ""));
				continue;
			}
			const target = item.type === "search" ? item.query : item.type === "url" ? item.url : `${item.path ?? ""}${item.subpath ?? ""}`;
			rows.push({ target: target ?? "", title: item.title ?? "", type: item.type ?? "", group });
		}
	};
	walk(Array.isArray(data?.items) ? data.items : [], "");
	return list(params, rows, { columns: on(params, "verbose") ? ["type", "target", "title"] : ["target", "title"] });
};

// ---- Bases

// file= may leave out .base, which a wikilink would need.
export function baseFile(ctx: Ctx, params: CliData) {
	const named = params.file !== undefined && params.path === undefined && !params.file.endsWith(".base") ? resolveName(ctx.app, `${params.file}.base`) : null;
	const f = named ?? targetFile(ctx, params);
	if (f.extension !== "base") throw usage(`${f.path} is not a .base file.`);
	return f;
}

async function baseDocument(app: App, f: TFile) {
	const doc = new BaseDocument(await app.vault.read(f));
	if (doc.error) throw new CliError(`${f.path}: ${doc.error}`);
	return doc;
}

const bases: Handler = (ctx, params) => {
	const rows = ctx.app.vault
		.getFiles()
		.filter((f) => f.extension === "base")
		.map((f) => f.path)
		.sort(sortPaths)
		.map((path) => ({ path }));
	return list(params, rows, { columns: ["path"] });
};

const baseViews: Handler = async (ctx, params) => {
	const doc = await baseDocument(ctx.app, baseFile(ctx, params));
	const rows = doc.views.map((v) => ({ name: v.name, type: v.type }));
	return list(params, rows, { columns: ["name", "type"] });
};

export function pickView(doc: BaseDocument, name: string | undefined) {
	const index = name === undefined ? 0 : doc.views.findIndex((v) => v.name === name);
	if (index < 0) throw new CliError(`No view "${name}"; the base has: ${doc.views.map((v) => v.name).join(", ")}.`);
	return { index, view: doc.views[index] };
}

const baseQuery: Handler = async (ctx, params) => {
	const f = baseFile(ctx, params);
	const doc = await baseDocument(ctx.app, f);
	const { view } = pickView(doc, params.view);
	const config = new BasesViewConfig(view, doc.config);
	const run = new QueryRun(ctx.app, doc.config.formulas, f, f.path);
	const out = executeQuery(run, doc.config, config, ctx.app.vault.getFiles());
	const table = viewTable(config, out.result.data);
	const rows = out.result.data.map((entry, i) => ({ path: entry.file.path, ...Object.fromEntries(table.header.map((h, c) => [h, table.rows[i][c]])) }));
	const format = params.json === "true" ? "json" : oneOf(params, "format", ["json", "csv", "tsv", "md", "paths"] as const, "json");
	if (format === "json") return result(rows, JSON.stringify(rows, null, 2));
	return list({ ...params, format }, rows, { columns: format === "paths" ? ["path"] : table.header, formats: ["csv", "tsv", "md", "paths"] });
};

// ---- Random notes, workspaces, vault

export function randomNote(ctx: Ctx, params: CliData) {
	const folder = folderParam(ctx, params, "folder");
	const notes = ctx.app.vault.getMarkdownFiles().filter((f) => inFolder(f.path, folder));
	if (!notes.length) throw new CliError("No notes to pick from.");
	return notes[Math.floor(Math.random() * notes.length)];
}

const randomRead: Handler = async (ctx, params) => {
	const f = randomNote(ctx, params);
	const content = await ctx.app.vault.read(f);
	return result({ path: f.path, content }, `${f.path}\n\n${content}`);
};

export async function savedWorkspaces(app: App): Promise<{ workspaces: Record<string, unknown>; active: string }> {
	const data = await readConfigJson(app, "workspaces.json");
	const workspaces = data?.workspaces && typeof data.workspaces === "object" ? data.workspaces : {};
	return { workspaces, active: typeof data?.active === "string" ? data.active : "" };
}

const workspaces: Handler = async (ctx, params) => {
	const { workspaces: saved, active } = await savedWorkspaces(ctx.app);
	const rows = Object.keys(saved).map((name) => ({ name, active: name === active }));
	return list(params, rows, { columns: ["name"] });
};

const vault: Handler = (ctx, params) => {
	const { vault: v } = ctx.app;
	const stats = folderStats(v.getRoot());
	const info = { name: v.getName(), path: v.adapter.getBasePath(), ...stats };
	if (params.info !== undefined) {
		const key = oneOf(params, "info", ["name", "path", "files", "folders", "size"] as const, "name");
		return result(info[key], String(info[key]));
	}
	return keyValues(info);
};

const version: Handler = (ctx) => {
	const data = { justnotes: ctx.version, obsidianApi: apiVersion };
	return { data, text: `justnotes ${data.justnotes} (Obsidian API ${data.obsidianApi})` };
};

export const VAULT_COMMANDS: Record<string, Handler> = {
	version,
	file,
	files,
	folder,
	folders,
	read,
	search: searchFiles,
	"search:context": searchContext,
	backlinks,
	links,
	unresolved,
	orphans,
	deadends,
	neighbours,
	outline,
	wordcount,
	tags,
	tag,
	tasks,
	task,
	properties,
	"property:read": propertyRead,
	aliases,
	"daily:path": dailyPath,
	"daily:read": dailyRead,
	templates,
	"template:read": templateRead,
	bookmarks,
	bases,
	"base:views": baseViews,
	"base:query": baseQuery,
	"random:read": randomRead,
	workspaces,
	vault,
};
