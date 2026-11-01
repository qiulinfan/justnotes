// Obsidian's Options pages (General, Editor, Files and links, Appearance),
// with Obsidian 1.14's names, order and app.json/appearance.json keys. They
// are declarative tabs: a control's key is a vault setting (SettingTab's
// getControlValue/setControlValue read and save it through the vault), so
// search finds every option. A setting justnotes cannot honour is left out
// rather than shown as a toggle that does nothing.
import type { App } from "./app";
import { getElectron } from "./dom";
import { EDITOR_SETTING_RANGES, type EditorSettings, editorSettings, setEditorSetting } from "./editor-settings";
import { SettingTab } from "./plugin";
import { Modal } from "./ui/modal";
import { Notice } from "./ui/notice";
import type { Setting } from "./ui/setting";
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingGroupItem } from "./ui/setting-definitions";
import { automaticUpdates, checkForUpdates, setAutomaticUpdates, updateState } from "./updates";
import { apiVersion } from "./util";

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 30;
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

export function clampFontSize(size: number) {
	return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);

// A font setting ("Inter" or "Inter, Arial") as a CSS font-family list;
// empty when unset. Names are quoted, generic families are not.
export function fontFamilyList(value: unknown): string {
	if (typeof value !== "string") return "";
	return value
		.split(",")
		.map((name) => name.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean)
		.map((name) => (GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name.replace(/["\\]/g, "\\$&")}"`))
		.join(", ");
}

// The zoom is the app's, not the vault's: Chromium shares it between the
// windows of the page's origin, and localStorage `zoom-factor` keeps it.
export function setZoomFactor(factor: number) {
	const value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, factor));
	getElectron().webFrame.setZoomFactor(value);
	storeZoom(value);
}

export function storeZoom(value: number) {
	try {
		if (Math.abs(value - 1) < 0.001) localStorage.removeItem("zoom-factor");
		else localStorage.setItem("zoom-factor", String(value));
	} catch {}
}

// Opens a folder of the config folder (themes, snippets) in the system's
// file manager; Obsidian creates it, justnotes writes nothing else in
// .obsidian, so a missing folder is reported instead.
async function openConfigFolder(app: App, path: string) {
	if (!(await app.vault.adapter.exists(path))) {
		new Notice(`${path} does not exist yet.`);
		return;
	}
	app.openWithDefaultApp(path);
}

const command = (app: App, id: string) => () => app.commands.executeCommandById(id);
const hasCommand = (app: App, id: string) => !!app.commands.findCommand(id);

// ---------------------------------------------------------------- General

export class GeneralTab extends SettingTab {
	constructor(app: App) {
		super(app);
		this.id = "about";
		this.name = "General";
		this.icon = "settings";
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const app = this.app;
		let version = "";
		try {
			version = getElectron().remote.app.getVersion();
		} catch {}
		const commit = updateState().commit;
		return [
			{
				type: "group",
				items: [
					{
						name: "Current version",
						desc: `justnotes ${version}${commit ? ` (${commit.slice(0, 7)})` : ""}, Obsidian API ${apiVersion}.`,
						render: (setting) => {
							setting.addButton((b) => b.setButtonText("Check for updates").onClick(() => void checkForUpdates()));
						},
					},
					{
						name: "Automatic updates",
						desc:
							updateState().status === "unsupported"
								? "justnotes updates itself only when installed as an app, in a folder it can write; run from the repository, it updates with git."
								: "Check GitHub for a newer build at start and every six hours, download it, and install it when justnotes quits or restarts.",
						render: (setting) => {
							setting.addToggle((t) => t.setValue(automaticUpdates()).onChange((on) => setAutomaticUpdates(on)));
						},
					},
					{
						name: "Language",
						desc: "justnotes has no translations, so its interface is in English.",
						render: (setting) => {
							setting.addDropdown((d) => d.addOption("en", "English").setValue("en").setDisabled(true));
						},
					},
					{
						name: "Help",
						desc: "justnotes' own page says what works and how to run it; Obsidian's help describes the features justnotes reimplements.",
						render: (setting) => {
							if (hasCommand(app, "app:open-help")) setting.addButton((b) => b.setButtonText("Open").onClick(command(app, "app:open-help")));
							setting.addButton((b) => b.setButtonText("Obsidian help").onClick(() => window.open("https://help.obsidian.md", "_blank")));
						},
					},
				],
			},
			{
				type: "group",
				heading: "Vault",
				items: [
					{ name: "Vault name", desc: app.vault.getName() },
					{
						name: "Location",
						desc: app.vault.adapter.basePath,
						render: (setting) => {
							setting.addButton((b) => b.setButtonText("Reveal").onClick(() => app.showInFolder("/")));
						},
					},
					{
						name: "Manage vaults",
						desc: "Open another vault, create one, or remove one from the list.",
						visible: () => hasCommand(app, "app:open-vault"),
						render: (setting) => {
							setting.addButton((b) => b.setButtonText("Manage").onClick(command(app, "app:open-vault")));
						},
					},
				],
			},
		];
	}
}

// ---------------------------------------------------------------- Editor

// Sections other parts of justnotes add at the end of the Editor page.
export const editorSections: ((app: App) => SettingDefinitionGroup)[] = [];

// Controls for justnotes' own editor settings (editor-settings.ts,
// localStorage `justnotes-editor`): each saves and applies at once.
type NumberKey = keyof typeof EDITOR_SETTING_RANGES;
type ChoiceKey = { [K in keyof EditorSettings]: EditorSettings[K] extends string ? K : never }[keyof EditorSettings];
type ToggleKey = { [K in keyof EditorSettings]: EditorSettings[K] extends boolean ? K : never }[keyof EditorSettings];

function settingSlider(app: App, key: NumberKey, step: number): SettingDefinition["render"] {
	const [min, max] = EDITOR_SETTING_RANGES[key];
	return (setting) => {
		setting.addSlider((slider) =>
			slider
				.setLimits(min, max, step)
				.setValue(editorSettings(app)[key])
				.setDynamicTooltip()
				.setInstant(true)
				.onChange((value) => setEditorSetting(app, key, value)),
		);
	};
}

function settingDropdown<K extends ChoiceKey>(app: App, key: K, options: Record<EditorSettings[K], string>): SettingDefinition["render"] {
	return (setting) => {
		setting.addDropdown((dropdown) =>
			dropdown
				.addOptions(options)
				.setValue(editorSettings(app)[key])
				.onChange((value) => setEditorSetting(app, key, value as EditorSettings[K])),
		);
	};
}

function settingToggle(app: App, key: ToggleKey): SettingDefinition["render"] {
	return (setting) => {
		setting.addToggle((toggle) => toggle.setValue(editorSettings(app)[key]).onChange((value) => setEditorSetting(app, key, value)));
	};
}

// justnotes' own editor settings, after Obsidian's.
function justnotesEditorSection(app: App): SettingDefinitionGroup {
	return {
		type: "group",
		heading: "justnotes",
		items: [
			{
				name: "Selection scroll speed",
				desc: "How fast a note scrolls while you drag a selection past its top or bottom edge, in the editor and the reading view. It speeds up the farther the pointer goes past the edge; 1 is a little faster than Obsidian.",
				render: settingSlider(app, "selectionScrollSpeed", 1),
			},
			{
				name: "Line height",
				desc: "The space between lines in notes, in the editor and the reading view, as a multiple of the font size. 1.5 is Obsidian's.",
				render: settingSlider(app, "lineHeight", 0.05),
			},
			{
				name: "Pasted and dropped images as",
				desc: "How an image pasted or dropped into a note is written: an HTML <img> with a zoom style, as Typora writes it, a wikilink embed, or a Markdown image link.",
				render: settingDropdown(app, "pastedImageFormat", { html: "HTML img", wikilink: "Wikilink embed", markdown: "Markdown link" }),
			},
		],
	};
}
editorSections.push(justnotesEditorSection);

function codeBlockSection(app: App): SettingDefinitionGroup {
	return {
		type: "group",
		heading: "Code blocks",
		items: [
			{
				name: "Code block style",
				desc: "Typora: the ``` lines stay hidden while you edit the code, the language is set at the bottom right, and the source shows only when a selection covers the whole block. Obsidian: the ``` lines show while the cursor is in the block.",
				render: settingDropdown(app, "codeBlockStyle", { typora: "Typora", obsidian: "Obsidian" }),
			},
			{
				name: "Code font size",
				desc: "The size of code in code blocks, in percent of the text's, in the editor and the reading view. 87.5 is Obsidian's.",
				render: settingSlider(app, "codeFontSize", 2.5),
			},
			{
				name: "Line numbers in code blocks",
				desc: "Number the lines of every code block, in the editor and the reading view.",
				render: settingToggle(app, "codeLineNumbers"),
			},
			{
				name: "Language field",
				desc: "With the Typora style, when the language field at a block's bottom right shows: always, or only while the cursor is in the block.",
				render: settingDropdown(app, "codeLanguageField", { always: "Always", editing: "While editing" }),
			},
		],
	};
}
editorSections.push(codeBlockSection);

function mathBlockSection(app: App): SettingDefinitionGroup {
	return {
		type: "group",
		heading: "Math blocks",
		items: [
			{
				name: "Math block style",
				desc: "What a $$ block shows while the cursor is in it. Obsidian: only its source. Typora: its source with the rendered math below, updated as you type.",
				render: settingDropdown(app, "mathBlockStyle", { obsidian: "Obsidian", typora: "Typora" }),
			},
			{
				name: "Math block size",
				desc: "The size of display math, in percent, in the editor and the reading view.",
				render: settingSlider(app, "mathSize", 5),
			},
			{
				name: "Math block alignment",
				desc: "Where display math sits in the line, in the editor and the reading view.",
				render: settingDropdown(app, "mathAlign", { center: "Center", left: "Left" }),
			},
		],
	};
}
editorSections.push(mathBlockSection);

export class EditorTab extends SettingTab {
	constructor(app: App) {
		super(app);
		this.id = "editor";
		this.name = "Editor";
		this.icon = "pencil";
	}

	// "Default editing mode" is the boolean livePreview as a choice.
	getControlValue(key: string): unknown {
		if (key === "editingMode") return this.app.vault.getConfig("livePreview") === false ? "source" : "live";
		return super.getControlValue(key);
	}

	setControlValue(key: string, value: unknown) {
		if (key === "editingMode") return this.app.vault.setConfig("livePreview", value !== "source");
		return super.setControlValue(key, value);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const toggle = (key: string) => ({ type: "toggle" as const, key });
		return [
			{
				type: "group",
				items: [
					{ name: "Always focus new tabs", desc: "When you open a link in a new tab, switch to it immediately.", control: toggle("focusNewTab") },
					{
						name: "Default view for new tabs",
						desc: "The default view that a new Markdown tab gets opened in.",
						control: { type: "dropdown", key: "defaultViewMode", options: { source: "Editing view", preview: "Reading view" } },
					},
					{
						name: "Default editing mode",
						desc: "The default editing mode a new tab will start with.",
						control: { type: "dropdown", key: "editingMode", options: { live: "Live Preview", source: "Source mode" } },
					},
				],
			},
			{
				type: "group",
				heading: "Display",
				items: [
					{ name: "Readable line length", desc: "Limit maximum line length. Less content fits onscreen, but long blocks of text are more readable.", control: toggle("readableLineLength") },
					{ name: "Strict line breaks", desc: "Markdown specs ignore single line breaks in reading view. Turn this off to make single line breaks visible.", control: toggle("strictLineBreaks") },
					{
						name: "Properties in document",
						desc: "Choose how properties are displayed at the top of notes. Select source to show properties as raw YAML.",
						aliases: ["frontmatter"],
						control: { type: "dropdown", key: "propertiesInDocument", options: { visible: "Visible", hidden: "Hidden", source: "Source" } },
					},
					{ name: "Fold heading", desc: "Fold all content under a heading by selecting the collapse icon next to it.", control: toggle("foldHeading") },
					{ name: "Fold indent", desc: "Fold part of an indentation, such as lists, by selecting the collapse icon.", control: toggle("foldIndent") },
					{ name: "Show line numbers", desc: "Show line numbers in the gutter.", control: toggle("showLineNumber") },
					{ name: "Show indentation guides", desc: "Show vertical relationship lines between list items.", control: toggle("showIndentGuide") },
					{ name: "Right-to-left (RTL)", desc: "Sets the default text direction of notes to right-to-left.", control: toggle("rightToLeft") },
					{ name: "Auto-pair brackets", desc: "Pair brackets and quotes automatically.", control: toggle("autoPairBrackets") },
					{
						name: "Auto-pair Markdown syntax",
						desc: "Pair symbols automatically for bold, italic, code, and more: a mark typed over selected text wraps the text in it.",
						control: toggle("autoPairMarkdown"),
					},
					{
						name: "Smart lists",
						desc: "Automatically set indentation and place list items correctly: Enter continues a list item or ends an empty one, Backspace takes a list mark back.",
						control: toggle("smartIndentList"),
					},
					{ name: "Indent using tabs", desc: "Use tabs to indent by pressing the Tab key. Turn this off to indent using spaces.", control: toggle("useTab") },
					{
						name: "Convert pasted HTML to Markdown",
						desc: "Automatically convert HTML to Markdown when pasting and drag-and-drop from web pages. Use Ctrl/Cmd+Shift+V to paste without converting.",
						control: toggle("autoConvertHtml"),
					},
				],
			},
			{
				type: "group",
				heading: "Behavior",
				items: [
					{
						name: "Spellcheck",
						desc: `Turn on the spellchecker. Right-click a misspelled word for suggestions.${process.platform === "darwin" ? " The macOS spellchecker detects the language itself." : ""}`,
						control: toggle("spellcheck"),
					},
					{
						name: "Indent visual width",
						desc: "Number of spaces a tab character will render as (and indents with, when not indenting using tabs).",
						aliases: ["tab size"],
						control: { type: "slider", key: "tabSize", min: 1, max: 8, step: 1 },
					},
				],
			},
			...editorSections.map((section) => section(this.app)),
		];
	}
}

// ---------------------------------------------------------- Files and links

type AttachmentLocation = "root" | "folder" | "current" | "subfolder";

// "Default location for new attachments" is encoded in attachmentFolderPath,
// as in Obsidian: "/" the vault folder, "./" the note's folder, "./name" a
// subfolder of it, any other path that folder.
export function attachmentLocation(path: unknown): { location: AttachmentLocation; folder: string } {
	const p = typeof path === "string" && path ? path : "/";
	if (p === "/") return { location: "root", folder: "" };
	if (p === "." || p === "./") return { location: "current", folder: "" };
	if (p.startsWith("./")) return { location: "subfolder", folder: p.slice(2) };
	return { location: "folder", folder: p };
}

export class FilesAndLinksTab extends SettingTab {
	// The folder last typed for each kind, so switching back keeps it.
	#folders: Record<"folder" | "subfolder", string> = { folder: "attachments", subfolder: "attachments" };

	constructor(app: App) {
		super(app);
		this.id = "file";
		this.name = "Files and links";
		this.icon = "folder-cog";
	}

	getControlValue(key: string): unknown {
		const vault = this.app.vault;
		const current = attachmentLocation(vault.getConfig("attachmentFolderPath"));
		if (key === "attachmentLocation") return current.location;
		if (key === "attachmentFolder") return current.location === "folder" ? current.folder : this.#folders.folder;
		if (key === "attachmentSubfolder") return current.location === "subfolder" ? current.folder : this.#folders.subfolder;
		if (key === "useWikilinks") return vault.getConfig("useMarkdownLinks") !== true;
		return super.getControlValue(key);
	}

	setControlValue(key: string, value: unknown) {
		const vault = this.app.vault;
		const text = typeof value === "string" ? value.trim() : "";
		if (key === "attachmentLocation") {
			const path = { root: "/", current: "./", folder: this.#folders.folder, subfolder: `./${this.#folders.subfolder}` }[value as AttachmentLocation] ?? "/";
			return vault.setConfig("attachmentFolderPath", path);
		}
		if (key === "attachmentFolder") {
			if (text) this.#folders.folder = text;
			return vault.setConfig("attachmentFolderPath", text || "/");
		}
		if (key === "attachmentSubfolder") {
			if (text) this.#folders.subfolder = text;
			return vault.setConfig("attachmentFolderPath", text ? `./${text}` : "./");
		}
		if (key === "useWikilinks") return vault.setConfig("useMarkdownLinks", value !== true);
		return super.setControlValue(key, value);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const vault = this.app.vault;
		const current = attachmentLocation(vault.getConfig("attachmentFolderPath"));
		if (current.location === "folder" || current.location === "subfolder") this.#folders[current.location] = current.folder;
		const attachmentsAt = (location: AttachmentLocation) => () => attachmentLocation(vault.getConfig("attachmentFolderPath")).location === location;
		const filters = () => (vault.getConfig("userIgnoreFilters") as unknown[]).filter((f): f is string => typeof f === "string");
		return [
			{
				type: "group",
				items: [
					{
						name: "Default location for new notes",
						desc: "Where newly created notes are placed. Plugin settings will override this.",
						control: {
							type: "dropdown",
							key: "newFileLocation",
							options: { root: "Vault folder", current: "Same folder as current file", folder: "In the folder specified below" },
						},
					},
					{
						name: "Folder to create new notes in",
						desc: "Newly created notes will appear under this folder. Plugin settings will override this.",
						visible: () => vault.getConfig("newFileLocation") === "folder",
						control: { type: "folder", key: "newFileFolderPath", placeholder: "Example: folder 1/folder 2" },
					},
					{
						name: "Default location for new attachments",
						desc: "Where newly added attachments are placed.",
						control: {
							type: "dropdown",
							key: "attachmentLocation",
							options: { root: "Vault folder", folder: "In the folder specified below", current: "Same folder as current file", subfolder: "In subfolder under current folder" },
						},
					},
					{
						name: "Attachment folder path",
						desc: "Place newly created attachment files, such as images created via drag-and-drop or audio recordings, in this folder.",
						visible: attachmentsAt("folder"),
						control: { type: "folder", key: "attachmentFolder", placeholder: "Example: folder 1/folder 2" },
					},
					{
						name: "Subfolder name",
						desc: "If your file is under \"vault/folder\", and you set subfolder name to \"attachments\", attachments will be saved to \"vault/folder/attachments\".",
						visible: attachmentsAt("subfolder"),
						control: { type: "text", key: "attachmentSubfolder", placeholder: "attachments" },
					},
				],
			},
			{
				type: "group",
				heading: "Links",
				items: [
					{
						name: "New link format",
						desc: "What links to insert when auto-generating internal links.",
						control: { type: "dropdown", key: "newLinkFormat", options: { shortest: "Shortest path when possible", relative: "Relative path to file", absolute: "Absolute path in vault" } },
					},
					{
						name: "Automatically update internal links",
						desc: "When enabled, internal links are updated when you rename a file. Turn this off to be prompted to update links after renaming.",
						control: { type: "toggle", key: "alwaysUpdateLinks" },
					},
					{
						name: "Use [[Wikilinks]]",
						desc: "Auto-generate Wikilinks for [[links]] and [[images]] instead of Markdown links and images. Disable this option to generate Markdown links instead.",
						aliases: ["markdown links"],
						control: { type: "toggle", key: "useWikilinks" },
					},
					{
						name: "Show all file types",
						desc: "Show files with any extension even if they cannot be opened natively, so you can link to them and see them in the file explorer and quick switcher.",
						aliases: ["Detect all file extensions"],
						control: { type: "toggle", key: "showUnsupportedFiles" },
					},
				],
			},
			{
				type: "group",
				heading: "Trash",
				items: [
					{ name: "Confirm file deletion", desc: "Ask before deleting a file.", control: { type: "toggle", key: "promptDelete" } },
					{
						name: "Deleted files",
						desc: "What happens to a file after you delete it.",
						control: { type: "dropdown", key: "trashOption", options: { system: "Move to system trash", local: "Move to Obsidian trash (.trash folder)", none: "Permanently delete" } },
					},
				],
			},
			{
				type: "group",
				heading: "Advanced",
				items: [
					{
						type: "page",
						name: "Excluded files",
						desc: "Excluded files are hidden in search, graph view and unlinked mentions, and less noticeable in the quick switcher and link suggestions.",
						displayValue: () => {
							const n = filters().length;
							return n ? `${n} ${n === 1 ? "filter" : "filters"}` : "";
						},
						items: [
							{
								type: "list",
								heading: "Filters",
								emptyState: "Nothing is excluded.",
								items: filters().map((filter) => ({ name: filter, desc: filter.length > 2 && filter.startsWith("/") && filter.endsWith("/") ? "Regular expression" : "Path prefix" })),
								onDelete: (index) => {
									const next = filters();
									next.splice(index, 1);
									vault.setConfig("userIgnoreFilters", next);
									this.update();
								},
								addItem: {
									name: "Add filter",
									action: () =>
										new FilterModal(this.app, (filter) => {
											if (!filters().includes(filter)) vault.setConfig("userIgnoreFilters", [...filters(), filter]);
											this.update();
										}).open(),
								},
							},
						],
					},
				],
			},
		];
	}
}

// Asks for one excluded-files filter: a path prefix or a /regex/.
class FilterModal extends Modal {
	constructor(app: App, onSubmit: (filter: string) => void) {
		super(app);
		this.setTitle("Add excluded files filter");
		this.contentEl.createDiv({ cls: "setting-item-description", text: "A path such as folder/ or Daily/2023, or a regular expression between slashes such as /\\.excalidraw\\.md$/." });
		const input = this.contentEl.createEl("input", { type: "text", cls: "prompt-modal-input" });
		const submit = () => {
			const value = input.value.trim();
			if (!value) return;
			this.close();
			onSubmit(value);
		};
		this.scope.register([], "Enter", () => {
			submit();
			return false;
		});
		const buttons = this.contentEl.createDiv("modal-button-container");
		buttons.createEl("button", { cls: "mod-cta", text: "Add" }).addEventListener("click", submit);
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		this.onOpen = () => input.focus();
	}
}

// ------------------------------------------------------------- Appearance

export class AppearanceTab extends SettingTab {
	constructor(app: App) {
		super(app);
		this.id = "appearance";
		this.name = "Appearance";
		this.icon = "palette";
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const app = this.app;
		const vault = app.vault;
		const css = app.customCss;
		const themeNames = Object.keys(css.themes).sort((a, b) => a.localeCompare(b));
		const fontRow = (name: string, desc: string, key: string): SettingGroupItem => ({
			name,
			desc: `${desc} Font names separated by commas; empty for the theme's.`,
			control: { type: "text", key, placeholder: "Theme default" },
		});
		return [
			{
				type: "group",
				items: [
					{
						name: "Base color scheme",
						desc: "Choose the default color scheme.",
						aliases: ["theme", "dark mode", "light mode"],
						control: { type: "dropdown", key: "theme", options: { system: "Adapt to system", moonstone: "Light", obsidian: "Dark" } },
					},
					{
						name: "Accent color",
						desc: "Choose the accent color used throughout the app.",
						render: (setting) => {
							const value = vault.getConfig("accentColor");
							const color = typeof value === "string" && value ? value : getComputedStyle(document.body).getPropertyValue("--interactive-accent").trim();
							setting.addExtraButton((b) =>
								b
									.setIcon("rotate-ccw")
									.setTooltip("Restore default")
									.onClick(() => {
										vault.setConfig("accentColor", "");
										this.update();
									}),
							);
							setting.addColorPicker((c) => c.setValue(/^#[0-9a-f]{6}$/i.test(color) ? color : "#7f6df2").onChange((v) => vault.setConfig("accentColor", v)));
						},
					},
					{
						name: "Themes",
						desc: themeNames.length ? "The theme installed in the vault's themes folder that styles the app." : "No themes are installed in the vault's themes folder.",
						render: (setting) => {
							setting.addExtraButton((b) =>
								b
									.setIcon("refresh-cw")
									.setTooltip("Reload themes")
									.onClick(async () => {
										await css.readThemes();
										this.update();
									}),
							);
							setting.addExtraButton((b) => b.setIcon("folder-open").setTooltip("Open themes folder").onClick(() => openConfigFolder(app, css.getThemeFolder())));
							setting.addDropdown((d) => {
								d.addOption("", "Default");
								for (const name of themeNames) d.addOption(name, name);
								// A theme set in appearance.json but missing here.
								if (css.theme && !themeNames.includes(css.theme)) d.addOption(css.theme, `${css.theme} (not installed)`);
								d.setValue(css.theme).onChange((name) => css.setTheme(name));
							});
						},
					},
				],
			},
			{
				type: "group",
				heading: "Font",
				items: [
					fontRow("Interface font", "Set base font for the whole app.", "interfaceFontFamily"),
					fontRow("Text font", "Set font for editing and reading views.", "textFontFamily"),
					fontRow("Monospace font", "Set font for places like code blocks and frontmatter.", "monospaceFontFamily"),
					{
						name: "Font size",
						desc: "Font size in pixels that affects editing and reading views.",
						control: { type: "slider", key: "baseFontSize", min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: 1 },
					},
					{
						name: "Quick font size adjustment",
						desc: "Adjust the font size using Ctrl/Cmd+Scroll, or using the trackpad pinch-zoom gesture.",
						control: { type: "toggle", key: "baseFontSizeAction" },
					},
				],
			},
			{
				type: "group",
				heading: "Interface",
				items: [
					{ name: "Show tab title bar", desc: "Display the header at the top of every tab.", aliases: ["view header"], control: { type: "toggle", key: "showViewHeader" } },
					{ name: "Show ribbon", desc: "Display vertical toolbar on the side of the window.", control: { type: "toggle", key: "showRibbon" } },
				],
			},
			{
				type: "group",
				heading: "Advanced",
				items: [
					{
						name: "Zoom level",
						desc: "Controls the overall zoom level of the app, in every vault window (the View menu's zoom changes it too).",
						render: (setting) => {
							setting.addExtraButton((b) =>
								b
									.setIcon("rotate-ccw")
									.setTooltip("Restore default")
									.onClick(() => {
										setZoomFactor(1);
										this.update();
									}),
							);
							setting.addSlider((s) =>
								s
									.setLimits(ZOOM_MIN * 100, ZOOM_MAX * 100, 10)
									.setValue(Math.round(getElectron().webFrame.getZoomFactor() * 100))
									.setDisplayFormat((v) => `${v}%`)
									.onChange((v) => setZoomFactor(v / 100)),
							);
						},
					},
				],
			},
			{
				type: "list",
				heading: "CSS snippets",
				extraButtons: [
					(b) =>
						b
							.setIcon("refresh-cw")
							.setTooltip("Reload snippets")
							.onClick(async () => {
								await css.readSnippets();
								this.update();
							}),
					(b) => b.setIcon("folder-open").setTooltip("Open snippets folder").onClick(() => openConfigFolder(app, css.getSnippetsFolder())),
				],
				emptyState: `No CSS snippets in ${css.getSnippetsFolder()}.`,
				items: css.snippets.map((name) => ({
					name,
					desc: `${css.getSnippetsFolder()}/${name}.css`,
					render: (setting: Setting) => {
						setting.addToggle((t) => t.setValue(css.enabledSnippets.has(name)).onChange((on) => css.setCssEnabledStatus(name, on)));
					},
				})),
			},
		];
	}
}
