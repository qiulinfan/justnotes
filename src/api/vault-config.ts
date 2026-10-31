// The vault's Obsidian settings: `.obsidian/app.json` and
// `.obsidian/appearance.json`, shared with Obsidian and synced with git.
// justnotes writes them as Obsidian does: only after a setting changes, with
// two-space JSON, keys it does not know kept in place, and a key written only
// once it is set (an unset key reads Obsidian's default). A file changed on
// disk meanwhile (Obsidian, git) is read again and merged key by key: the
// keys justnotes changed take its values, every other key the file's.

// The keys Obsidian keeps in appearance.json; every other key goes to app.json.
export const APPEARANCE_KEYS = new Set([
	"accentColor",
	"baseFontSize",
	"baseFontSizeAction",
	"cssTheme",
	"enabledCssSnippets",
	"interfaceFontFamily",
	"monospaceFontFamily",
	"nativeMenus",
	"showRibbon",
	"showViewHeader",
	"textFontFamily",
	"theme",
	"translucency",
]);

export type ConfigFileName = "app.json" | "appearance.json";
export const CONFIG_FILES: ConfigFileName[] = ["app.json", "appearance.json"];

// Obsidian's defaults for the settings the files leave unset, as its
// settings screens show them.
export const DEFAULT_CONFIG: Record<string, unknown> = {
	accentColor: "",
	alwaysUpdateLinks: false,
	attachmentFolderPath: "/",
	autoConvertHtml: true,
	autoPairBrackets: true,
	autoPairMarkdown: true,
	baseFontSize: 16,
	baseFontSizeAction: true,
	cssTheme: "",
	defaultViewMode: "source",
	enabledCssSnippets: [],
	focusNewTab: true,
	foldHeading: true,
	foldIndent: true,
	interfaceFontFamily: "",
	legacyEditor: false,
	livePreview: true,
	monospaceFontFamily: "",
	newFileFolderPath: "",
	newFileLocation: "root",
	newLinkFormat: "shortest",
	promptDelete: true,
	propertiesInDocument: "visible",
	readableLineLength: true,
	rightToLeft: false,
	showIndentGuide: true,
	showInlineTitle: true,
	showLineNumber: false,
	showRibbon: true,
	showUnsupportedFiles: false,
	showViewHeader: true,
	smartIndentList: true,
	spellcheck: false,
	strictLineBreaks: false,
	tabSize: 4,
	textFontFamily: "",
	theme: "system",
	translucency: false,
	trashOption: "system",
	useMarkdownLinks: false,
	useTab: true,
	userIgnoreFilters: [],
	vimMode: false,
};

export type ConfigData = Record<string, unknown>;

// A file's text as settings; null when it is not a settings object (half
// written, or broken by hand), which must then be left alone.
export function parseConfig(text: string): ConfigData | null {
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

export function serializeConfig(data: ConfigData) {
	return JSON.stringify(data, null, 2);
}

export function sameValue(a: unknown, b: unknown) {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

// A pending change: the new value, or UNSET to remove the key.
export const UNSET: unique symbol = Symbol("unset");
export type ConfigChange = unknown | typeof UNSET;

// The file's settings with the changes applied: changed keys keep their
// place, removed keys go, new keys are added at the end.
export function applyConfigChanges(data: ConfigData, changes: Map<string, ConfigChange>): ConfigData {
	const out: ConfigData = {};
	for (const [key, value] of Object.entries(data)) {
		if (!changes.has(key)) out[key] = value;
		else if (changes.get(key) !== UNSET) out[key] = changes.get(key);
	}
	for (const [key, value] of changes) if (!(key in data) && value !== UNSET) out[key] = value;
	return out;
}

export interface ConfigIO {
	// The file's text, or null when there is none.
	read(name: ConfigFileName): Promise<string | null>;
	write(name: ConfigFileName, text: string): Promise<void>;
	// A file that does not parse while changes wait for it.
	unreadable?(name: ConfigFileName): void;
}

interface FileState {
	// What the file held when last read or written; null for no file.
	text: string | null;
	data: ConfigData;
}

// The two files and the changes waiting to be written. `config` is what
// getConfig reads: appearance.json under app.json, with the pending changes
// over both.
export class VaultConfigStore {
	config: ConfigData = {};
	#io: ConfigIO;
	#files: Record<ConfigFileName, FileState> = { "app.json": { text: null, data: {} }, "appearance.json": { text: null, data: {} } };
	#pending = new Map<string, ConfigChange>();
	#announced = "{}";
	#queue: Promise<void> = Promise.resolve();

	constructor(io: ConfigIO) {
		this.#io = io;
	}

	get hasPending() {
		return this.#pending.size > 0;
	}

	// Whether the settings differ from when this was last asked (or a set):
	// a read or a save took in a change made on disk.
	takeChanged() {
		const now = serializeConfig(this.config);
		if (now === this.#announced) return false;
		this.#announced = now;
		return true;
	}

	// Reads both files, keeping what a file that does not parse held before.
	reload(): Promise<void> {
		return this.#run(async () => {
			for (const name of CONFIG_FILES) await this.#read(name);
			this.#compose();
		});
	}

	// Sets a key in memory (UNSET removes it); false when the value is what
	// the key already reads, Obsidian's default included, so nothing changes
	// and nothing needs writing.
	set(key: string, value: ConfigChange): boolean {
		const present = key in this.config;
		if (value === UNSET ? !present : sameValue(value, present ? this.config[key] : DEFAULT_CONFIG[key])) return false;
		this.#pending.set(key, value === UNSET ? UNSET : clone(value));
		this.#compose();
		this.#announced = serializeConfig(this.config);
		return true;
	}

	// Writes the pending changes, each file read first and merged.
	save(): Promise<void> {
		return this.#run(async () => {
			if (!this.#pending.size) return;
			const byFile = new Map<ConfigFileName, Map<string, ConfigChange>>();
			for (const name of CONFIG_FILES) await this.#read(name);
			for (const [key, value] of this.#pending) {
				const name = this.#fileOf(key);
				if (!byFile.has(name)) byFile.set(name, new Map());
				byFile.get(name)!.set(key, value);
			}
			for (const [name, changes] of byFile) {
				const state = this.#files[name];
				if (state.text !== null && parseConfig(state.text) === null) {
					this.#io.unreadable?.(name);
					continue;
				}
				const out = serializeConfig(applyConfigChanges(state.data, changes));
				for (const key of changes.keys()) this.#pending.delete(key);
				if (out === state.text || (state.text === null && out === "{}")) continue;
				await this.#io.write(name, out);
				state.text = out;
				state.data = parseConfig(out)!;
			}
			this.#compose();
		});
	}

	// A key stays in the file that holds it (app.json first, which wins on
	// read); a new key goes where Obsidian keeps it.
	#fileOf(key: string): ConfigFileName {
		if (key in this.#files["app.json"].data) return "app.json";
		if (key in this.#files["appearance.json"].data) return "appearance.json";
		return APPEARANCE_KEYS.has(key) ? "appearance.json" : "app.json";
	}

	async #read(name: ConfigFileName) {
		const state = this.#files[name];
		const text = await this.#io.read(name);
		if (text === state.text) return;
		state.text = text;
		if (text === null) state.data = {};
		else {
			const data = parseConfig(text);
			if (data) state.data = data;
		}
	}

	#compose() {
		const merged: ConfigData = { ...this.#files["appearance.json"].data, ...this.#files["app.json"].data };
		for (const [key, value] of this.#pending) {
			if (value === UNSET) delete merged[key];
			else merged[key] = value;
		}
		this.config = merged;
	}

	#run<T>(task: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(task);
		this.#queue = run.then(
			() => {},
			() => {},
		);
		return run;
	}
}

function clone<T>(value: T): T {
	return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
