import { addCursorAbove, addCursorBelow, deleteLine, indentLess, indentMore, moveLineDown, moveLineUp } from "@codemirror/commands";
import { foldAll, toggleFold, unfoldAll } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { App } from "../api/app";
import { Editor } from "../api/editor";
import {
	clearFormatting,
	cycleListChecklist,
	insertCallout,
	insertCodeBlock,
	insertMarkdownLink,
	insertMathBlock,
	insertTable,
	insertTagMarker,
	insertWikilink,
	MARKUP,
	runEdit,
	type StateEdit,
	setHeading,
	toggleBlockquote,
	toggleBulletList,
	toggleChecklistStatus,
	toggleMarkup,
	toggleNumberedList,
} from "../api/editor-commands";
import { TagSuggest } from "../api/editor-suggests";
import type { Command, Modifier } from "../api/keymap";
import { clickableTokenAt, searchTag } from "../api/live-preview";
import { MarkdownView } from "../api/markdown-view";
import type { PaneType } from "../api/workspace";
import type { SearchView } from "./search";
import { CommandPalette, QuickSwitcher } from "./views";

export function registerCoreCommands(app: App) {
	const add = (id: string, name: string, hotkey: [string[], string] | null, callback: () => any) =>
		app.commands.addCommand({ id, name, callback, hotkeys: hotkey ? [{ modifiers: hotkey[0] as any, key: hotkey[1] }] : undefined });
	add("command-palette:open", "Command palette: Open command palette", [["Mod"], "p"], () => new CommandPalette(app).open());
	add("switcher:open", "Quick switcher: Open quick switcher", [["Mod"], "o"], () => new QuickSwitcher(app).open());
	add("app:open-settings", "Open settings", [["Mod"], ","], () => app.setting.open());
	add("app:toggle-left-sidebar", "Toggle left sidebar", null, () => app.workspace.leftSplit.toggle());
	add("app:toggle-right-sidebar", "Toggle right sidebar", null, () => app.workspace.rightSplit.toggle());
	add("global-search:open", "Search: Search in all files", [["Mod", "Shift"], "f"], async () => {
		const leaf = await app.workspace.ensureSideLeaf("search", "left", { reveal: true });
		app.workspace.setActiveLeaf(leaf);
		const input = (leaf.view as SearchView).inputEl;
		input.focus();
		input.select();
	});
	add("app:reload", "Reload app without saving", [["Mod"], "r"], () => location.reload());
	add("workspace:new-tab", "New tab", [["Mod"], "t"], () => app.workspace.setActiveLeaf(app.workspace.getLeaf("tab"), { focus: true }));
	add("workspace:close", "Close current tab", [["Mod"], "w"], () => app.workspace.activeLeaf?.detach());
	add("file-explorer:new-file", "Create new note", [["Mod"], "n"], async () => {
		const file = await app.fileManager.createNewMarkdownFile(app.fileManager.getNewFileParent(""));
		await app.workspace.getLeaf(false).openFile(file);
	});
	app.commands.addCommand({
		id: "editor:save-file",
		name: "Save current file",
		hotkeys: [{ modifiers: ["Mod"], key: "s" }],
		checkCallback: (checking) => {
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) return false;
			if (!checking) view.save();
			return true;
		},
	});
	registerEditorCommands(app);
}

// Obsidian's built-in editor commands, with its ids and default hotkeys.
// They run only in a Markdown editor, so in other views their keys fall
// through to that view; hotkeys.json overrides them like any command.
function registerEditorCommands(app: App) {
	const editorCommand = (
		id: string,
		name: string,
		run: (editor: Editor, view: any) => boolean | void,
		hotkey?: [Modifier[], string],
		available: (editor: Editor) => boolean = () => true,
	) => {
		const command: Command = {
			id: `editor:${id}`,
			name,
			hotkeys: hotkey ? [{ modifiers: hotkey[0], key: hotkey[1] }] : undefined,
			editorCheckCallback: (checking, editor, view) => {
				if (!(editor instanceof Editor) || !available(editor)) return false;
				if (!checking) run(editor, view);
				return true;
			},
		};
		app.commands.addCommand(command);
		app.commands.editorCommands[command.id] = command;
	};
	const edit = (id: string, name: string, change: StateEdit, hotkey?: [Modifier[], string]) =>
		editorCommand(id, name, (editor) => runEdit(editor, change), hotkey);
	const cm = (id: string, name: string, command: (view: EditorView) => boolean, hotkey?: [Modifier[], string]) =>
		editorCommand(id, name, (editor) => command(editor.cm), hotkey);
	const suggest = (editor: Editor, view: any) => app.workspace.editorSuggest.trigger(editor, view?.file ?? null, true);

	edit("toggle-bold", "Toggle bold", toggleMarkup(MARKUP.bold), [["Mod"], "b"]);
	edit("toggle-italics", "Toggle italics", toggleMarkup(MARKUP.italic), [["Mod"], "i"]);
	edit("toggle-strikethrough", "Toggle strikethrough", toggleMarkup(MARKUP.strikethrough));
	edit("toggle-highlight", "Toggle highlight", toggleMarkup(MARKUP.highlight));
	edit("toggle-code", "Toggle code", toggleMarkup(MARKUP.code));
	edit("toggle-inline-math", "Toggle math", toggleMarkup(MARKUP.math));
	edit("toggle-comments", "Toggle comment", toggleMarkup(MARKUP.comment), [["Mod"], "/"]);
	edit("clear-formatting", "Clear formatting", clearFormatting);
	edit("insert-link", "Insert Markdown link", insertMarkdownLink, [["Mod"], "k"]);
	editorCommand("insert-wikilink", "Add internal link", (editor, view) => {
		runEdit(editor, insertWikilink(false));
		suggest(editor, view);
	});
	editorCommand("insert-embed", "Add embed", (editor, view) => {
		runEdit(editor, insertWikilink(true));
		suggest(editor, view);
	});
	editorCommand("insert-tag", "Add tag", (editor, view) => {
		runEdit(editor, insertTagMarker);
		const tags = app.workspace.editorSuggest.suggests.find((s) => s instanceof TagSuggest) as TagSuggest | undefined;
		if (tags) tags.force = true;
		suggest(editor, view);
	});

	edit("toggle-checklist-status", "Toggle checkbox status", toggleChecklistStatus, [["Mod"], "l"]);
	edit("cycle-list-checklist", "Cycle bullet/checkbox", cycleListChecklist);
	edit("toggle-bullet-list", "Toggle bullet list", toggleBulletList);
	edit("toggle-numbered-list", "Toggle numbered list", toggleNumberedList);
	edit("toggle-blockquote", "Toggle blockquote", toggleBlockquote);
	edit("set-heading-0", "Remove heading", setHeading(0));
	for (let level = 1; level <= 6; level++) edit(`set-heading-${level}`, `Set as heading ${level}`, setHeading(level));
	cm("indent-list", "Indent list", indentMore);
	cm("unindent-list", "Unindent list", indentLess);
	edit("insert-callout", "Insert callout", insertCallout);
	edit("insert-codeblock", "Insert code block", insertCodeBlock);
	edit("insert-mathblock", "Insert math block", insertMathBlock);
	edit("insert-table", "Insert table", insertTable);

	cm("swap-line-up", "Swap line up", moveLineUp);
	cm("swap-line-down", "Swap line down", moveLineDown);
	cm("delete-paragraph", "Delete paragraph", deleteLine, [["Mod"], "d"]);
	cm("add-cursor-above", "Add cursor above", addCursorAbove);
	cm("add-cursor-below", "Add cursor below", addCursorBelow);
	cm("toggle-fold", "Toggle fold on the current line", toggleFold);
	cm("fold-all", "Fold all headings and lists", foldAll);
	cm("unfold-all", "Unfold all headings and lists", unfoldAll);

	// Link commands apply only with a link under the cursor, so their keys
	// (Mod+Enter, Alt+Enter) otherwise keep their editing meaning.
	const linkAt = (editor: Editor) => clickableTokenAt(editor.cm.state, editor.cm.state.selection.main.head);
	const follow = (pane: false | PaneType) => (editor: Editor, view: any) => {
		const token = linkAt(editor);
		if (!token) return;
		if (token.type === "tag") searchTag(app, token.text);
		else if (token.type === "external-link") require("electron").shell.openExternal(token.text);
		else app.workspace.openLinkText(token.text, view?.file?.path ?? "", pane);
	};
	const hasLink = (editor: Editor) => !!linkAt(editor);
	editorCommand("follow-link", "Follow link under cursor", follow(false), [["Alt"], "Enter"], hasLink);
	editorCommand("open-link-in-new-leaf", "Open link under cursor in new tab", follow("tab"), [["Mod"], "Enter"], hasLink);
	editorCommand("open-link-in-new-split", "Open link under cursor to the right", follow("split"), [["Mod", "Alt"], "Enter"], hasLink);
	editorCommand("open-link-in-new-window", "Open link under cursor in new window", follow("window"), [["Mod", "Alt", "Shift"], "Enter"], hasLink);

	editorCommand("context-menu", "Show context menu", (editor, view) => {
		const coords = editor.cm.coordsAtPos(editor.cm.state.selection.main.head);
		if (coords) view?.showContextMenu?.(new MouseEvent("contextmenu", { clientX: coords.left, clientY: coords.bottom }));
	});

	// Focus works from anywhere, so it is not an editor command.
	app.commands.addCommand({
		id: "editor:focus",
		name: "Focus on editor",
		checkCallback: (checking) => {
			let target: MarkdownView | null = null;
			const recent = app.workspace.getMostRecentLeaf();
			if (recent?.view instanceof MarkdownView) target = recent.view;
			app.workspace.iterateRootLeaves((leaf) => {
				target ??= leaf.view instanceof MarkdownView ? leaf.view : null;
			});
			if (!target) return false;
			if (!checking) {
				const view: MarkdownView = target;
				app.workspace.setActiveLeaf(view.leaf, { focus: true });
				view.editor.focus();
			}
			return true;
		},
	});
}
