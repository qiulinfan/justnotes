import type { CliFlags } from "../api/plugin";

// The built-in commands of `justnotes`: Obsidian's CLI commands, with their
// names and flags (docs.obsidian.md, "Obsidian CLI"), and justnotes' own.
// The app runs them (renderer/cli.ts), the command reads a vault itself for
// the read-only ones when no app is running (offline.ts), and `help` and
// `completion` print this table.

// Where a command runs:
//   vault  in the vault window; with no app running, the command reads the
//          vault folder itself (no active file, no open editors then)
//   app    in the vault window; with no app running, the command starts it
//   main   in the app's main process (opening and listing vault windows)
//   client in the command itself
export type Where = "vault" | "app" | "main" | "client";

export interface CommandSpec {
	name: string;
	group: string;
	description: string;
	flags: CliFlags;
	where: Where;
}

const FILE: CliFlags = {
	file: { value: "<name>", description: "File name, resolved like a wikilink" },
	path: { value: "<path>", description: "File path from the vault root" },
};

// Every command listing rows takes these; `total` prints the count only.
const LIST: CliFlags = {
	format: { value: "tsv|csv|json|md|yaml|paths", description: "Output format (default: tsv; text for some)" },
	total: { description: "Print the count only" },
};

const PANE: CliFlags = { paneType: { value: "tab|split|window", description: "Where to open the note" } };
const NEWTAB: CliFlags = { newtab: { description: "Open in a new tab" } };
const ID: CliFlags = { id: { value: "<id>", description: "Plugin id", required: true } };
const NAME = (description: string, required = true): CliFlags => ({ name: { value: "<name>", description, required } });
const CONTENT: CliFlags = { content: { value: "<text>", description: "Text to add (- reads stdin)", required: true } };

const COMMANDS: CommandSpec[] = [
	// General
	{ name: "help", group: "General", description: "List the commands, or show one command's flags", flags: {}, where: "client" },
	{ name: "version", group: "General", description: "Show the justnotes version and the Obsidian API it implements", flags: {}, where: "vault" },
	{ name: "reload", group: "General", description: "Reload the vault window", flags: {}, where: "app" },
	{ name: "restart", group: "General", description: "Restart the app, reopening its vault windows", flags: {}, where: "main" },
	{ name: "quit", group: "General", description: "Quit the app (saving open notes first)", flags: {}, where: "main" },

	// Files and folders
	{ name: "file", group: "Files and folders", description: "Show file info (default: active file)", flags: { ...FILE }, where: "vault" },
	{
		name: "files",
		group: "Files and folders",
		description: "List files in the vault",
		flags: { folder: { value: "<path>", description: "Only files under this folder" }, ext: { value: "<extension>", description: "Only files with this extension" }, ...LIST },
		where: "vault",
	},
	{
		name: "folder",
		group: "Files and folders",
		description: "Show folder info",
		flags: { path: { value: "<path>", description: "Folder path", required: true }, info: { value: "files|folders|size", description: "Print one value only" } },
		where: "vault",
	},
	{ name: "folders", group: "Files and folders", description: "List folders in the vault", flags: { folder: { value: "<path>", description: "Only folders under this one" }, ...LIST }, where: "vault" },
	{ name: "open", group: "Files and folders", description: "Open a file", flags: { ...FILE, ...NEWTAB }, where: "app" },
	{
		name: "create",
		group: "Files and folders",
		description: "Create a file, or overwrite one",
		flags: {
			name: { value: "<name>", description: "File name (in the folder for new notes)" },
			path: { value: "<path>", description: "File path from the vault root" },
			content: { value: "<text>", description: "Initial content (- reads stdin)" },
			template: { value: "<name>", description: "Template to start from" },
			overwrite: { description: "Overwrite the file if it exists" },
			open: { description: "Open the file afterwards" },
			...NEWTAB,
		},
		where: "app",
	},
	{ name: "read", group: "Files and folders", description: "Print a file's contents (default: active file)", flags: { ...FILE }, where: "vault" },
	{ name: "append", group: "Files and folders", description: "Append to a file (default: active file)", flags: { ...FILE, ...CONTENT, inline: { description: "Append without a newline" } }, where: "app" },
	{
		name: "prepend",
		group: "Files and folders",
		description: "Prepend to a file, after its frontmatter (default: active file)",
		flags: { ...FILE, ...CONTENT, inline: { description: "Prepend without a newline" } },
		where: "app",
	},
	{
		name: "move",
		group: "Files and folders",
		description: "Move or rename a file, updating links (default: active file)",
		flags: { ...FILE, to: { value: "<path>", description: "Destination folder or path", required: true } },
		where: "app",
	},
	{ name: "rename", group: "Files and folders", description: "Rename a file, updating links (default: active file)", flags: { ...FILE, ...NAME("New name (the extension is kept)") }, where: "app" },
	{
		name: "delete",
		group: "Files and folders",
		description: "Delete a file to the trash (default: active file)",
		flags: { ...FILE, permanent: { description: "Delete permanently, skipping the trash" } },
		where: "app",
	},

	// Search
	{
		name: "search",
		group: "Search",
		description: "Search the notes; prints matching paths",
		flags: {
			query: { value: "<text>", description: "Text, /regex/ or tag:#tag", required: true },
			path: { value: "<folder>", description: "Only notes under this folder" },
			limit: { value: "<n>", description: "At most this many files" },
			format: { value: "text|json", description: "Output format (default: text)" },
			total: { description: "Print the number of matching files" },
			case: { description: "Case sensitive" },
		},
		where: "vault",
	},
	{
		name: "search:context",
		group: "Search",
		description: "Search with matching lines, as path:line: text",
		flags: {
			query: { value: "<text>", description: "Text, /regex/ or tag:#tag", required: true },
			path: { value: "<folder>", description: "Only notes under this folder" },
			limit: { value: "<n>", description: "At most this many files" },
			format: { value: "text|json", description: "Output format (default: text)" },
			case: { description: "Case sensitive" },
		},
		where: "vault",
	},
	{ name: "search:open", group: "Search", description: "Open the search pane", flags: { query: { value: "<text>", description: "Initial query" } }, where: "app" },

	// Links and graph
	{ name: "backlinks", group: "Links and graph", description: "List notes linking to a file (default: active file)", flags: { ...FILE, counts: { description: "Include link counts" }, ...LIST }, where: "vault" },
	{ name: "links", group: "Links and graph", description: "List a file's outgoing links (default: active file)", flags: { ...FILE, ...LIST }, where: "vault" },
	{
		name: "unresolved",
		group: "Links and graph",
		description: "List links to notes that do not exist",
		flags: { counts: { description: "Include link counts" }, verbose: { description: "Include the notes that link" }, ...LIST },
		where: "vault",
	},
	{ name: "orphans", group: "Links and graph", description: "List notes nothing links to", flags: { ...LIST }, where: "vault" },
	{ name: "deadends", group: "Links and graph", description: "List notes that link to nothing", flags: { ...LIST }, where: "vault" },
	{
		name: "neighbours",
		group: "Links and graph",
		description: "List notes within a number of links of a file, as the local graph (default: active file)",
		flags: {
			...FILE,
			depth: { value: "<n>", description: "Link steps to follow (default: 1)" },
			direction: { value: "both|out|in", description: "Follow outgoing links, backlinks or both (default: both)" },
			unresolved: { description: "Include links to notes that do not exist" },
			...LIST,
		},
		where: "vault",
	},

	// Outline and word count
	{
		name: "outline",
		group: "Outline and word count",
		description: "Show a file's headings (default: active file)",
		flags: { ...FILE, format: { value: "tree|md|json", description: "Output format (default: tree)" }, total: { description: "Print the number of headings" } },
		where: "vault",
	},
	{
		name: "wordcount",
		group: "Outline and word count",
		description: "Count words and characters (default: active file)",
		flags: { ...FILE, words: { description: "Print the word count only" }, characters: { description: "Print the character count only" } },
		where: "vault",
	},

	// Tags
	{
		name: "tags",
		group: "Tags",
		description: "List tags in the vault, or in one file",
		flags: { ...FILE, sort: { value: "count", description: "Sort by count (default: name)" }, counts: { description: "Include note counts" }, active: { description: "Tags of the active file" }, ...LIST },
		where: "vault",
	},
	{
		name: "tag",
		group: "Tags",
		description: "Show a tag's notes and count (nested tags included)",
		flags: { ...NAME("Tag name, with or without #"), total: { description: "Print the count only" }, verbose: { description: "Include the notes" } },
		where: "vault",
	},

	// Tasks
	{
		name: "tasks",
		group: "Tasks",
		description: "List tasks in the vault, or in one file",
		flags: {
			...FILE,
			status: { value: "<char>", description: "Only tasks with this status character" },
			done: { description: "Only completed tasks" },
			todo: { description: "Only open tasks" },
			verbose: { description: "Group by file, with line numbers" },
			active: { description: "Tasks of the active file" },
			daily: { description: "Tasks of today's daily note" },
			format: { value: "text|tsv|csv|json|md|yaml", description: "Output format (default: text)" },
			total: { description: "Print the count only" },
		},
		where: "vault",
	},
	{
		name: "task",
		group: "Tasks",
		description: "Show a task, or change its status",
		flags: {
			ref: { value: "<path:line>", description: "Task as path:line" },
			...FILE,
			line: { value: "<n>", description: "Line number (from 1)" },
			daily: { description: "In today's daily note" },
			status: { value: "<char>", description: "Set this status character" },
			toggle: { description: "Toggle done and open" },
			done: { description: "Mark done" },
			todo: { description: "Mark open" },
		},
		where: "vault",
	},

	// Properties
	{
		name: "properties",
		group: "Properties",
		description: "List properties in the vault, or one file's",
		flags: {
			...FILE,
			name: { value: "<name>", description: "One property's note count" },
			sort: { value: "count", description: "Sort by count (default: name)" },
			counts: { description: "Include note counts" },
			active: { description: "Properties of the active file" },
			format: { value: "yaml|json|tsv|csv|md", description: "Output format (default: yaml)" },
			total: { description: "Print the count only" },
		},
		where: "vault",
	},
	{
		name: "property:read",
		group: "Properties",
		description: "Print a property's value (default: active file)",
		flags: { ...NAME("Property name"), ...FILE },
		where: "vault",
	},
	{
		name: "property:set",
		group: "Properties",
		description: "Set a property (default: active file)",
		flags: {
			...NAME("Property name"),
			value: { value: "<value>", description: "Value (a list is comma-separated or JSON)", required: true },
			type: { value: "text|list|number|checkbox|date|datetime", description: "Value type (default: the property's type)" },
			...FILE,
		},
		where: "app",
	},
	{ name: "property:remove", group: "Properties", description: "Remove a property (default: active file)", flags: { ...NAME("Property name"), ...FILE }, where: "app" },
	{
		name: "aliases",
		group: "Properties",
		description: "List aliases in the vault, or one file's",
		flags: { ...FILE, verbose: { description: "Include the notes" }, active: { description: "Aliases of the active file" }, ...LIST },
		where: "vault",
	},

	// Daily notes
	{ name: "daily", group: "Daily notes", description: "Open today's daily note, creating it from its template", flags: { ...PANE }, where: "app" },
	{ name: "daily:path", group: "Daily notes", description: "Print today's daily note path, even before it exists", flags: {}, where: "vault" },
	{ name: "daily:read", group: "Daily notes", description: "Print today's daily note", flags: {}, where: "vault" },
	{
		name: "daily:append",
		group: "Daily notes",
		description: "Append to today's daily note",
		flags: { ...CONTENT, inline: { description: "Append without a newline" }, open: { description: "Open the note afterwards" }, ...PANE },
		where: "app",
	},
	{
		name: "daily:prepend",
		group: "Daily notes",
		description: "Prepend to today's daily note, after its frontmatter",
		flags: { ...CONTENT, inline: { description: "Prepend without a newline" }, open: { description: "Open the note afterwards" }, ...PANE },
		where: "app",
	},

	// Unique notes
	{
		name: "unique",
		group: "Unique notes",
		description: "Create a note named by the time (zk-prefixer.json's format and folder)",
		flags: { name: { value: "<text>", description: "Text after the time stamp" }, content: { value: "<text>", description: "Initial content (- reads stdin)" }, open: { description: "Open the note afterwards" }, ...PANE },
		where: "app",
	},

	// Templates
	{ name: "templates", group: "Templates", description: "List templates in the templates folder", flags: { ...LIST }, where: "vault" },
	{
		name: "template:read",
		group: "Templates",
		description: "Print a template",
		flags: { ...NAME("Template name"), resolve: { description: "Fill {{date}}, {{time}} and {{title}}" }, title: { value: "<title>", description: "Title for {{title}}" } },
		where: "vault",
	},
	{ name: "template:insert", group: "Templates", description: "Insert a template into the active note", flags: { ...NAME("Template name") }, where: "app" },

	// Bookmarks
	{ name: "bookmarks", group: "Bookmarks", description: "List bookmarks", flags: { verbose: { description: "Include bookmark types" }, ...LIST }, where: "vault" },
	{
		name: "bookmark",
		group: "Bookmarks",
		description: "Add a bookmark",
		flags: {
			file: { value: "<path>", description: "File to bookmark" },
			subpath: { value: "<subpath>", description: "Heading or block in the file" },
			folder: { value: "<path>", description: "Folder to bookmark" },
			search: { value: "<query>", description: "Search to bookmark" },
			url: { value: "<url>", description: "URL to bookmark" },
			title: { value: "<title>", description: "Bookmark title" },
		},
		where: "app",
	},

	// Bases
	{ name: "bases", group: "Bases", description: "List .base files", flags: { ...LIST }, where: "vault" },
	{ name: "base:views", group: "Bases", description: "List a base's views (default: active base)", flags: { ...FILE, ...LIST }, where: "vault" },
	{
		name: "base:query",
		group: "Bases",
		description: "Run a base's view and print its rows (default: active base)",
		flags: { ...FILE, view: { value: "<name>", description: "View name (default: the first)" }, format: { value: "json|csv|tsv|md|paths", description: "Output format (default: json)" } },
		where: "vault",
	},
	{
		name: "base:create",
		group: "Bases",
		description: "Create a note in a base, with the properties its filters imply",
		flags: {
			...FILE,
			view: { value: "<name>", description: "View name" },
			name: { value: "<name>", description: "New note name" },
			content: { value: "<text>", description: "Initial content (- reads stdin)" },
			open: { description: "Open the note afterwards" },
			...NEWTAB,
		},
		where: "app",
	},

	// File history
	{
		name: "diff",
		group: "File history",
		description: "List a file's snapshots, or compare two versions (1 is the newest)",
		flags: {
			...FILE,
			from: { value: "<n>", description: "Version to compare from" },
			to: { value: "<n>", description: "Version to compare to (default: the file now)" },
			filter: { value: "local", description: "Version source (only local snapshots exist)" },
		},
		where: "app",
	},
	{ name: "history", group: "File history", description: "List a file's snapshots from File recovery", flags: { ...FILE, ...LIST }, where: "app" },
	{ name: "history:list", group: "File history", description: "List the files with snapshots", flags: { ...LIST }, where: "app" },
	{ name: "history:read", group: "File history", description: "Print a snapshot", flags: { ...FILE, version: { value: "<n>", description: "Version (default: 1, the newest)" } }, where: "app" },
	{
		name: "history:restore",
		group: "File history",
		description: "Restore a snapshot (the current text is snapshotted first)",
		flags: { ...FILE, version: { value: "<n>", description: "Version", required: true } },
		where: "app",
	},
	{ name: "history:open", group: "File history", description: "Open File recovery", flags: { ...FILE }, where: "app" },

	// Command palette
	{
		name: "commands",
		group: "Command palette",
		description: "List command ids",
		flags: { filter: { value: "<prefix>", description: "Only ids starting with this" }, verbose: { description: "Include names and hotkeys" }, ...LIST },
		where: "app",
	},
	{
		name: "command",
		group: "Command palette",
		description: "Run a command by id, or by its name in the palette",
		flags: { id: { value: "<command-id>", description: "Command id" }, name: { value: "<name>", description: "Command name, as the palette shows it" } },
		where: "app",
	},
	{ name: "hotkeys", group: "Command palette", description: "List hotkeys", flags: { verbose: { description: "Mark custom hotkeys" }, ...LIST }, where: "app" },
	{
		name: "hotkey",
		group: "Command palette",
		description: "Show a command's hotkey",
		flags: { id: { value: "<command-id>", description: "Command id", required: true }, verbose: { description: "Say whether it is custom or default" } },
		where: "app",
	},

	// Plugins
	{
		name: "plugins",
		group: "Plugins",
		description: "List installed plugins",
		flags: { filter: { value: "core|community", description: "Plugin type" }, versions: { description: "Include versions" }, ...LIST },
		where: "app",
	},
	{
		name: "plugins:enabled",
		group: "Plugins",
		description: "List enabled plugins",
		flags: { filter: { value: "core|community", description: "Plugin type" }, versions: { description: "Include versions" }, ...LIST },
		where: "app",
	},
	{ name: "plugins:restrict", group: "Plugins", description: "Show whether restricted mode is on (always off in justnotes)", flags: {}, where: "app" },
	{ name: "plugin", group: "Plugins", description: "Show a plugin's info", flags: { ...ID }, where: "app" },
	{ name: "plugin:enable", group: "Plugins", description: "Enable a community plugin", flags: { ...ID, filter: { value: "core|community", description: "Plugin type" } }, where: "app" },
	{ name: "plugin:disable", group: "Plugins", description: "Disable a community plugin", flags: { ...ID, filter: { value: "core|community", description: "Plugin type" } }, where: "app" },
	{ name: "plugin:reload", group: "Plugins", description: "Reload a community plugin", flags: { ...ID }, where: "app" },
	{ name: "plugin:uninstall", group: "Plugins", description: "Disable a community plugin and move its folder to the trash", flags: { ...ID }, where: "app" },

	// Themes and snippets
	{ name: "themes", group: "Themes and snippets", description: "List installed themes", flags: { versions: { description: "Include versions" }, ...LIST }, where: "app" },
	{ name: "theme", group: "Themes and snippets", description: "Show the active theme, or one theme's info", flags: { ...NAME("Theme name", false) }, where: "app" },
	{ name: "theme:set", group: "Themes and snippets", description: "Set the theme (empty name: the default)", flags: { name: { value: "<name>", description: "Theme name", required: true } }, where: "app" },
	{ name: "theme:uninstall", group: "Themes and snippets", description: "Move a theme's folder to the trash", flags: { ...NAME("Theme name") }, where: "app" },
	{ name: "snippets", group: "Themes and snippets", description: "List CSS snippets", flags: { ...LIST }, where: "app" },
	{ name: "snippets:enabled", group: "Themes and snippets", description: "List enabled CSS snippets", flags: { ...LIST }, where: "app" },
	{ name: "snippet:enable", group: "Themes and snippets", description: "Enable a CSS snippet", flags: { ...NAME("Snippet name") }, where: "app" },
	{ name: "snippet:disable", group: "Themes and snippets", description: "Disable a CSS snippet", flags: { ...NAME("Snippet name") }, where: "app" },

	// Random notes
	{ name: "random", group: "Random notes", description: "Open a random note", flags: { folder: { value: "<path>", description: "Only notes under this folder" }, ...NEWTAB }, where: "app" },
	{ name: "random:read", group: "Random notes", description: "Print a random note, with its path", flags: { folder: { value: "<path>", description: "Only notes under this folder" } }, where: "vault" },

	// Workspace
	{ name: "workspace", group: "Workspace", description: "Show the layout tree", flags: { ids: { description: "Include item ids" } }, where: "app" },
	{ name: "tabs", group: "Workspace", description: "List open tabs", flags: { ids: { description: "Include tab ids" }, ...LIST }, where: "app" },
	{
		name: "tab:open",
		group: "Workspace",
		description: "Open a new tab",
		flags: { group: { value: "<id>", description: "Tab group id" }, file: { value: "<path>", description: "File to open" }, view: { value: "<type>", description: "View type to open" } },
		where: "app",
	},
	{ name: "recents", group: "Workspace", description: "List recently opened files", flags: { ...LIST }, where: "app" },
	{ name: "workspaces", group: "Workspace", description: "List saved workspaces (workspaces.json)", flags: { ...LIST }, where: "vault" },
	{ name: "workspace:load", group: "Workspace", description: "Load a saved workspace", flags: { ...NAME("Workspace name") }, where: "app" },

	// Vault
	{ name: "vault", group: "Vault", description: "Show vault info", flags: { info: { value: "name|path|files|folders|size", description: "Print one value only" } }, where: "vault" },
	{ name: "vaults", group: "Vault", description: "List known vaults", flags: { verbose: { description: "Include paths and whether a window shows each" }, ...LIST }, where: "main" },
	{
		name: "vault:open",
		group: "Vault",
		description: "Open a vault's window, starting the app if needed",
		flags: { name: { value: "<name>", description: "Known vault name" }, path: { value: "<path>", description: "Vault folder" } },
		where: "main",
	},

	// Developer
	{ name: "eval", group: "Developer", description: "Run JavaScript in the vault window and print the result", flags: { code: { value: "<javascript>", description: "Code (- reads stdin)", required: true } }, where: "app" },
	{ name: "devtools", group: "Developer", description: "Toggle the developer tools", flags: {}, where: "app" },
	{ name: "dev:debug", group: "Developer", description: "Attach or detach the DevTools Protocol debugger", flags: { on: { description: "Attach" }, off: { description: "Detach" } }, where: "app" },
	{
		name: "dev:cdp",
		group: "Developer",
		description: "Run a DevTools Protocol command",
		flags: { method: { value: "<CDP.method>", description: "Method to call", required: true }, params: { value: "<json>", description: "Parameters as JSON" } },
		where: "app",
	},
	{ name: "dev:errors", group: "Developer", description: "Show captured JavaScript errors", flags: { clear: { description: "Clear the buffer" } }, where: "app" },
	{ name: "dev:screenshot", group: "Developer", description: "Take a screenshot (base64 PNG, or a file)", flags: { path: { value: "<filename>", description: "Write the PNG here" } }, where: "app" },
	{
		name: "dev:console",
		group: "Developer",
		description: "Show captured console messages",
		flags: {
			limit: { value: "<n>", description: "At most this many (default: 50)" },
			level: { value: "log|warn|error|info|debug", description: "Only this level" },
			clear: { description: "Clear the buffer" },
		},
		where: "app",
	},
	{
		name: "dev:css",
		group: "Developer",
		description: "Show the CSS rules matching a selector, with their stylesheets",
		flags: { selector: { value: "<css>", description: "CSS selector", required: true }, prop: { value: "<name>", description: "Only this property" } },
		where: "app",
	},
	{
		name: "dev:dom",
		group: "Developer",
		description: "Query DOM elements",
		flags: {
			selector: { value: "<css>", description: "CSS selector", required: true },
			attr: { value: "<name>", description: "Print this attribute" },
			css: { value: "<prop>", description: "Print this computed CSS property" },
			total: { description: "Print the number of matches" },
			text: { description: "Print the text content" },
			inner: { description: "Print innerHTML instead of outerHTML" },
			all: { description: "All matches, not only the first" },
		},
		where: "app",
	},

	// Shell
	{
		name: "completion",
		group: "Shell",
		description: "Print a completion script: justnotes completion zsh|fish|bash",
		flags: { zsh: { description: "zsh" }, fish: { description: "fish" }, bash: { description: "bash" } },
		where: "client",
	},
];

export const BUILTINS = new Map(COMMANDS.map((spec) => [spec.name, spec]));

// Every built-in command also takes --json: its result as JSON.
export const JSON_FLAG: CliFlags = { json: { description: "Print the result as JSON" } };

export function flagsOf(spec: CommandSpec): CliFlags {
	return spec.name === "help" || spec.name === "completion" ? spec.flags : { ...spec.flags, ...JSON_FLAG };
}

// Obsidian commands justnotes leaves out, and why. They answer with this
// instead of "unknown command".
const MISSING: [RegExp, string][] = [
	[/^publish(:|$)/, "justnotes has no Obsidian Publish."],
	[/^sync(:|$)/, "justnotes has no sync service; the files are the data."],
	[/^web$/, "justnotes has no web viewer."],
	[/^(plugin|theme):install$/, "justnotes does not download plugins or themes; install them in Obsidian or copy their folder."],
	[/^dev:mobile$/, "justnotes has no mobile emulation."],
	[/^workspace:(save|delete)$/, "justnotes reads workspaces.json but never writes Obsidian's config; save workspaces in Obsidian."],
];

export function missingReason(command: string) {
	return MISSING.find(([re]) => re.test(command))?.[1] ?? null;
}

export const USAGE = "Usage: justnotes [--profile <dir>] [--offline] [vault=<name|path>] <command> [key=value ...] [flag ...] [--json] [--copy]";

const NOTES = [
	"",
	"Without vault=, the vault holding the current folder is used, else the focused window's.",
	"file=<name> resolves like a wikilink; path=<path> is exact. Without either, a command acts on the active file.",
	"content=- reads stdin. --json prints any command's result as JSON; --copy also copies the output.",
	"* also works with no app running: the command reads the vault folder itself (--offline forces it).",
	"  Commands without * start the app for the vault when it is not running.",
];

function columns(rows: [string, string][]) {
	const width = Math.max(...rows.map(([left]) => left.length));
	return rows.map(([left, right]) => (right ? `  ${left.padEnd(width)}  ${right}` : `  ${left}`));
}

export interface PluginCommand {
	name: string;
	description: string;
	pluginId: string;
	flags: CliFlags | null;
}

// The command list: built-ins by group, then the plugins' commands, which
// exist only while the app runs (null: not running).
export function helpText(plugins: PluginCommand[] | null): string {
	const lines = [USAGE];
	const groups = new Map<string, CommandSpec[]>();
	for (const spec of COMMANDS) groups.set(spec.group, [...(groups.get(spec.group) ?? []), spec]);
	for (const [group, specs] of groups) {
		lines.push("", `${group}:`);
		lines.push(...columns(specs.map((s) => [`${s.name}${s.where === "vault" ? " *" : ""}`, s.description])));
	}
	lines.push("", "Plugin commands:");
	if (plugins === null) lines.push("  (listed while the app runs)");
	else if (!plugins.length) lines.push("  (none registered)");
	else lines.push(...columns([...plugins].sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.name, `${p.description} (${p.pluginId})`])));
	lines.push(...NOTES);
	return lines.join("\n");
}

// One command's flags.
export function commandHelp(name: string, description: string, flags: CliFlags | null, origin: string): string {
	const lines = [`${name}  (${origin})`, description];
	const entries = Object.entries(flags ?? {});
	if (entries.length) {
		lines.push("", "Flags:");
		lines.push(...columns(entries.map(([key, flag]) => [flag.value ? `${key}=${flag.value}` : key, flag.description + (flag.required ? " (required)" : "")])));
	}
	return lines.join("\n");
}

export function builtinHelp(spec: CommandSpec) {
	const origin = { vault: "built-in; works without a running app", app: "built-in", main: "built-in", client: "built-in" }[spec.where];
	return commandHelp(spec.name, spec.description, flagsOf(spec), origin);
}
