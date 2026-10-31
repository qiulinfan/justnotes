import type { CorePluginHost } from "../api/internal-plugins";
import type { App } from "../api/app";
import { Notice } from "../api/ui/notice";
import { moment, normalizePath } from "../api/util";
import type { TFile } from "../api/vault";
import { fillTemplate } from "./templates";

export interface DailyNoteOptions {
	format?: string;
	folder?: string;
	template?: string;
	autorun?: boolean;
}

const DEFAULT_FORMAT = "YYYY-MM-DD";

const formatOf = (options: DailyNoteOptions) => options.format?.trim() || DEFAULT_FORMAT;
const folderOf = (options: DailyNoteOptions) => normalizePath(options.folder?.trim() || "/").replace(/^\/$/, "");

// The path of the daily note for `date`. The format may name folders too
// (YYYY/MM/YYYY-MM-DD).
export function dailyNotePath(options: DailyNoteOptions, date: moment.Moment) {
	const folder = folderOf(options);
	return normalizePath(`${folder ? `${folder}/` : ""}${date.format(formatOf(options))}.md`);
}

// The day a note is the daily note of, or null when its path does not read
// as one in the configured folder and format.
export function dailyNoteDate(options: DailyNoteOptions, path: string): moment.Moment | null {
	const folder = folderOf(options);
	if (!path.endsWith(".md") || (folder && !path.startsWith(`${folder}/`))) return null;
	const date = moment(path.slice(folder ? folder.length + 1 : 0, -3), formatOf(options), true);
	return date.isValid() ? date : null;
}

function options(app: App): DailyNoteOptions {
	return app.internalPlugins.getPluginById("daily-notes")?.instance.options ?? {};
}

async function ensureFolders(app: App, path: string) {
	const parts = path.split("/").slice(0, -1);
	for (let i = 1; i <= parts.length; i++) {
		const folder = parts.slice(0, i).join("/");
		if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
	}
}

// The daily note for `date`, made from the configured template when it does
// not exist yet.
export async function dailyNote(app: App, date: moment.Moment) {
	const opts = options(app);
	const path = dailyNotePath(opts, date);
	const existing = app.vault.getFileByPath(path);
	if (existing) return existing;
	let content = "";
	const template = opts.template?.trim();
	if (template) {
		const file = app.metadataCache.getFirstLinkpathDest(template, "");
		if (file) content = await app.vault.cachedRead(file);
		else new Notice(`The daily note template "${template}" was not found.`);
	}
	const format = formatOf(opts);
	content = fillTemplate(content, { title: date.format(format), date, dateFormat: format, timeFormat: "HH:mm" });
	await ensureFolders(app, path);
	return app.vault.create(path, content);
}

export async function openDailyNote(app: App, date = moment()) {
	try {
		const file = await dailyNote(app, date);
		await app.workspace.getLeaf(false).openFile(file, { active: true });
	} catch (err) {
		new Notice(`Could not open the daily note: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// The existing daily note before (-1) or after (1) the active one.
function adjacent(app: App, file: TFile, step: -1 | 1) {
	const opts = options(app);
	const day = dailyNoteDate(opts, file.path);
	if (!day) return null;
	let best: { file: TFile; date: moment.Moment } | null = null;
	for (const other of app.vault.getMarkdownFiles()) {
		const date = dailyNoteDate(opts, other.path);
		if (!date || (step < 0 ? !date.isBefore(day, "day") : !date.isAfter(day, "day"))) continue;
		if (!best || (step < 0 ? date.isAfter(best.date) : date.isBefore(best.date))) best = { file: other, date };
	}
	return best?.file ?? null;
}

// Obsidian's Daily notes commands and ribbon button, with its ids.
export function installDailyNotes(app: App, host: CorePluginHost) {
	host.addCommand({ id: "daily-notes", name: "Daily notes: Open today's daily note", callback: () => openDailyNote(app) });
	const go = (step: -1 | 1) => (checking: boolean) => {
		const file = app.workspace.getActiveFile();
		if (!file || !dailyNoteDate(options(app), file.path)) return false;
		if (checking) return true;
		const next = adjacent(app, file, step);
		if (next) app.workspace.getLeaf(false).openFile(next, { active: true });
		else new Notice(step < 0 ? "No earlier daily note." : "No later daily note.");
		return true;
	};
	host.addCommand({ id: "daily-notes:goto-prev", name: "Daily notes: Open previous daily note", checkCallback: go(-1) });
	host.addCommand({ id: "daily-notes:goto-next", name: "Daily notes: Open next daily note", checkCallback: go(1) });
	host.addRibbonIcon("daily-notes", "calendar-days", "Open today's daily note", () => openDailyNote(app));
	if (options(app).autorun && !host.userEnabled) app.workspace.onLayoutReady(() => openDailyNote(app));
}
