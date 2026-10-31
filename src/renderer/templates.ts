import type { App } from "../api/app";
import { Editor } from "../api/editor";
import { FuzzySuggestModal } from "../api/ui/suggest";
import { Notice } from "../api/ui/notice";
import { moment, normalizePath } from "../api/util";
import { TFile, TFolder } from "../api/vault";

export interface TemplateVars {
	title: string;
	date: moment.Moment;
	dateFormat: string;
	timeFormat: string;
}

// Obsidian's template variables: {{title}}, {{date}} and {{time}}, the last
// two with an optional format ({{date:dddd}}), and {{yesterday}} and
// {{tomorrow}}, which daily notes use. Unknown names stay as they are.
export function fillTemplate(text: string, vars: TemplateVars) {
	return text.replace(/{{\s*(title|date|time|yesterday|tomorrow)\s*(?::(.*?))?\s*}}/gi, (_all, name: string, format?: string) => {
		const custom = format?.trim();
		switch (name.toLowerCase()) {
			case "title":
				return vars.title;
			case "date":
				return vars.date.format(custom || vars.dateFormat);
			case "time":
				return vars.date.format(custom || vars.timeFormat);
			case "yesterday":
				return vars.date.clone().subtract(1, "day").format(custom || vars.dateFormat);
			default:
				return vars.date.clone().add(1, "day").format(custom || vars.dateFormat);
		}
	});
}

export interface TextEdit {
	from: number;
	to: number;
	insert: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

// The top-level keys of frontmatter lines, each with its lines (a key, then
// the indented or listed lines of its value).
function frontmatterEntries(body: string) {
	const entries: { key: string; lines: string[] }[] = [];
	for (const line of body.split(/\r?\n/)) {
		const key = /^([^\s#:-][^:]*):/.exec(line);
		if (key) entries.push({ key: key[1].trim(), lines: [line] });
		else if (entries.length && line.trim()) entries[entries.length - 1].lines.push(line);
	}
	return entries;
}

// The edits that insert a template into a note with the selection
// [from, to): the template's body replaces the selection, and its frontmatter
// goes to the top of the note, where properties the note has already keep
// their values, as Obsidian does.
export function templateEdits(doc: string, from: number, to: number, template: string): TextEdit[] {
	const fm = FRONTMATTER.exec(template);
	if (!fm) return [{ from, to, insert: template }];
	const body = template.slice(fm[0].length);
	const lines = (fm[1] ?? "").replace(/\r?\n$/, "");
	const own = FRONTMATTER.exec(doc);
	if (!own) {
		if (!lines.trim()) return [{ from, to, insert: body }];
		const block = `---\n${lines}\n---\n`;
		return from === 0 ? [{ from: 0, to, insert: block + body }] : [{ from: 0, to: 0, insert: block }, { from, to, insert: body }];
	}
	const keys = new Set(frontmatterEntries(own[1] ?? "").map((e) => e.key));
	const added = frontmatterEntries(lines).filter((e) => !keys.has(e.key));
	// The body never goes inside the note's frontmatter.
	const at = Math.max(from, own[0].length);
	const edits: TextEdit[] = [];
	if (added.length) {
		const close = own[0].lastIndexOf("---");
		edits.push({ from: close, to: close, insert: `${added.flatMap((e) => e.lines).join("\n")}\n` });
	}
	// A note that ends with its frontmatter has no line break after it yet.
	const gap = at === own[0].length && !own[0].endsWith("\n") ? "\n" : "";
	edits.push({ from: at, to: Math.max(to, at), insert: gap + body });
	return edits;
}

interface TemplatesOptions {
	folder?: string;
	dateFormat?: string;
	timeFormat?: string;
}

function options(app: App): TemplatesOptions {
	return app.internalPlugins.getPluginById("templates")?.instance.options ?? {};
}

const dateFormat = (app: App) => options(app).dateFormat?.trim() || "YYYY-MM-DD";
const timeFormat = (app: App) => options(app).timeFormat?.trim() || "HH:mm";

// The templates folder from templates.json, which Obsidian's settings set.
function templatesFolder(app: App) {
	const path = options(app).folder?.trim();
	if (!path) {
		new Notice("Set the templates folder in Obsidian's Templates settings first; justnotes only reads them.");
		return null;
	}
	const folder = app.vault.getAbstractFileByPath(normalizePath(path));
	if (!(folder instanceof TFolder)) {
		new Notice(`The templates folder "${path}" does not exist.`);
		return null;
	}
	return folder;
}

function templateFiles(folder: TFolder): TFile[] {
	return folder.children.flatMap((child) => (child instanceof TFolder ? templateFiles(child) : child instanceof TFile && child.extension === "md" ? [child] : []));
}

export async function insertTemplate(app: App, editor: Editor, title: string, file: TFile) {
	const text = fillTemplate(await app.vault.cachedRead(file), { title, date: moment(), dateFormat: dateFormat(app), timeFormat: timeFormat(app) });
	const cm = editor.cm;
	const { from, to } = cm.state.selection.main;
	const changes = cm.state.changes(templateEdits(cm.state.doc.toString(), from, to, text));
	cm.dispatch({ changes, selection: { anchor: changes.mapPos(to, 1) }, scrollIntoView: true, userEvent: "input" });
	editor.focus();
}

class TemplateModal extends FuzzySuggestModal<TFile> {
	#folder: TFolder;
	#editor: Editor;
	#title: string;

	constructor(app: App, folder: TFolder, editor: Editor, title: string) {
		super(app);
		this.#folder = folder;
		this.#editor = editor;
		this.#title = title;
		this.setPlaceholder("Type to search for a template...");
	}

	getItems() {
		return templateFiles(this.#folder).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
	}

	getItemText(file: TFile) {
		return file.path.slice(this.#folder.isRoot() ? 0 : this.#folder.path.length + 1, -3);
	}

	onChooseItem(file: TFile) {
		insertTemplate(this.app, this.#editor, this.#title, file);
	}
}

// Obsidian's Templates commands, with its ids. They need a note being edited.
export function registerTemplateCommands(app: App) {
	const command = (id: string, name: string, run: (editor: Editor, view: any) => void) => {
		const cmd = {
			id,
			name,
			editorCheckCallback: (checking: boolean, editor: unknown, view: any) => {
				if (!(editor instanceof Editor) || view?.getMode?.() === "preview") return false;
				if (!checking) run(editor, view);
				return true;
			},
		};
		app.commands.addCommand(cmd);
		app.commands.editorCommands[id] = cmd;
	};
	command("insert-template", "Templates: Insert template", (editor, view) => {
		const folder = templatesFolder(app);
		if (folder) new TemplateModal(app, folder, editor, view?.file?.basename ?? "").open();
	});
	command("insert-current-date", "Templates: Insert current date", (editor) => editor.replaceSelection(moment().format(dateFormat(app))));
	command("insert-current-time", "Templates: Insert current time", (editor) => editor.replaceSelection(moment().format(timeFormat(app))));
}
