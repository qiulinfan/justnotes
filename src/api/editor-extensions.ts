import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension, Prec } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, keymap, lineNumbers, ViewPlugin } from "@codemirror/view";
import { styleTags, Tag, tags as t } from "@lezer/highlight";
import type { BlockContext, LeafBlock, LeafBlockParser, MarkdownConfig } from "@lezer/markdown";
import type { App } from "./app";
import { editorEditorField, editorInfoField, editorLivePreviewField } from "./editor";
import { type LivePreviewHost, livePreview, livePreviewState } from "./live-preview";
import type { MarkdownView } from "./markdown-view";

// Obsidian syntax that lezer-markdown does not know. Nodes for Obsidian-only
// syntax take Obsidian's lowercase token names (math, hashtag, comment...),
// because plugins written against Obsidian test node names for those words.

// Each tag carries one of Obsidian's token class lists.
const tokenStyles: { tag: Tag; class: string }[] = [];
function token(cls: string) {
	const tag = Tag.define();
	tokenStyles.push({ tag, class: cls });
	return tag;
}

export const mathTag = token("cm-math");
const DOLLAR = 36;
const BACKSLASH = 92;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isDigit = (c: number) => c >= 48 && c <= 57;

const MATH_BEGIN = "formatting_formatting-math_formatting-math-begin_keyword_math";
const MATH_END = "formatting_formatting-math_formatting-math-end_keyword_math";
const MATH_BLOCK_BEGIN = `${MATH_BEGIN}_math-block`;
const MATH_BLOCK_END = `${MATH_END}_math-block`;

// `$…$` ends at the next unescaped `$`. As in pandoc, the opening `$` needs
// a non-space after it and the closing one a non-space before it and no
// digit after it, so "costs $5 and $10" stays text. `$$…$$` inside a
// paragraph is display math.
const mathSyntax: MarkdownConfig = {
	defineNodes: [
		{ name: "InlineMath" },
		{ name: "BlockMath", block: true },
		{ name: "math", style: mathTag },
		{ name: MATH_BEGIN, style: token("cm-formatting cm-formatting-math cm-formatting-math-begin cm-keyword cm-math") },
		{ name: MATH_END, style: token("cm-formatting cm-formatting-math cm-formatting-math-end cm-keyword cm-math") },
		{ name: MATH_BLOCK_BEGIN, style: token("cm-formatting cm-formatting-math cm-formatting-math-begin cm-keyword cm-math cm-math-block") },
		{ name: MATH_BLOCK_END, style: token("cm-formatting cm-formatting-math cm-formatting-math-end cm-keyword cm-math cm-math-block") },
	],
	parseInline: [
		{
			name: "InlineMath",
			before: "Escape",
			parse(cx, next, pos) {
				if (next !== DOLLAR) return -1;
				const fence = cx.char(pos + 1) === DOLLAR ? 2 : 1;
				if (fence === 1 && isSpace(cx.char(pos + 1))) return -1;
				for (let i = pos + fence; i < cx.end; i++) {
					const c = cx.char(i);
					if (c === BACKSLASH) {
						i++;
						continue;
					}
					if (c !== DOLLAR) continue;
					if (fence === 2 && cx.char(i + 1) !== DOLLAR) continue;
					if (i === pos + fence) return -1;
					if (fence === 1 && (isSpace(cx.char(i - 1)) || isDigit(cx.char(i + 1)))) return -1;
					const [begin, end] = fence === 2 ? [MATH_BLOCK_BEGIN, MATH_BLOCK_END] : [MATH_BEGIN, MATH_END];
					return cx.addElement(
						cx.elt("InlineMath", pos, i + fence, [cx.elt(begin, pos, pos + fence), cx.elt("math", pos + fence, i), cx.elt(end, i, i + fence)]),
					);
				}
				return -1;
			},
		},
	],
	parseBlock: [
		{
			name: "BlockMath",
			before: "FencedCode",
			parse(cx, line) {
				if (!line.text.slice(line.pos).startsWith("$$")) return false;
				const start = cx.lineStart + line.pos;
				const rest = line.text.slice(line.pos + 2).trimEnd();
				let close = -1;
				let end = cx.lineStart + line.text.length;
				// `$$ x $$` on one line is a complete block.
				if (rest.length >= 2 && rest.endsWith("$$")) close = start + rest.length;
				else {
					while (cx.nextLine()) {
						const text = line.text.trimEnd();
						end = cx.lineStart + line.text.length;
						if (text.endsWith("$$")) {
							close = cx.lineStart + text.length - 2;
							break;
						}
					}
				}
				cx.nextLine();
				const children = [cx.elt(MATH_BLOCK_BEGIN, start, start + 2)];
				const contentEnd = close >= 0 ? close : end;
				if (contentEnd > start + 2) children.push(cx.elt("math", start + 2, contentEnd));
				if (close >= 0) children.push(cx.elt(MATH_BLOCK_END, close, close + 2));
				cx.addElement(cx.elt("BlockMath", start, close >= 0 ? close + 2 : end, children));
				return true;
			},
		},
	],
};

// YAML frontmatter: a `---` first line up to the next `---` line. An
// unclosed block runs to the end, as it does while the closing line is
// being typed.
const frontmatterSyntax: MarkdownConfig = {
	defineNodes: [
		{ name: "hmd-frontmatter", block: true, style: { "hmd-frontmatter/...": token("cm-hmd-frontmatter") } },
		{ name: "formatting_hmd-frontmatter", style: token("cm-formatting cm-def") },
	],
	parseBlock: [
		{
			name: "hmd-frontmatter",
			before: "HorizontalRule",
			parse(cx, line) {
				if (cx.lineStart !== 0 || line.text !== "---") return false;
				const marks = [cx.elt("formatting_hmd-frontmatter", 0, 3)];
				let end = 3;
				while (cx.nextLine()) {
					end = cx.lineStart + line.text.length;
					if (line.text === "---") {
						marks.push(cx.elt("formatting_hmd-frontmatter", cx.lineStart, end));
						cx.nextLine();
						break;
					}
				}
				cx.addElement(cx.elt("hmd-frontmatter", 0, end, marks));
				return true;
			},
		},
	],
};

// `%%comment%%` inline, or from a `%%` line to the next `%%`.
const commentSyntax: MarkdownConfig = {
	defineNodes: [
		{ name: "comment", style: token("cm-comment") },
		{ name: "comment-block", block: true, style: token("cm-comment") },
	],
	parseInline: [
		{
			name: "comment",
			before: "Escape",
			parse(cx, next, pos) {
				if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
				const close = cx.slice(pos + 2, cx.end).indexOf("%%");
				return close < 0 ? -1 : cx.addElement(cx.elt("comment", pos, pos + close + 4));
			},
		},
	],
	parseBlock: [
		{
			name: "comment-block",
			after: "FencedCode",
			parse(cx, line) {
				const text = line.text.slice(line.pos);
				if (!text.startsWith("%%") || text.includes("%%", 2)) return false;
				const start = cx.lineStart + line.pos;
				let end = cx.lineStart + line.text.length;
				while (cx.nextLine()) {
					const i = line.text.indexOf("%%");
					end = cx.lineStart + (i < 0 ? line.text.length : i + 2);
					if (i >= 0) break;
				}
				cx.nextLine();
				cx.addElement(cx.elt("comment-block", start, end));
				return true;
			},
		},
	],
};

// `==highlight==`, a delimiter like GFM's `~~`.
const HighlightDelim = { resolve: "highlight", mark: "formatting-highlight" };
const highlightSyntax: MarkdownConfig = {
	defineNodes: [
		{ name: "highlight", style: { "highlight/...": token("cm-highlight") } },
		{ name: "formatting-highlight", style: token("cm-formatting cm-formatting-highlight") },
	],
	parseInline: [
		{
			name: "highlight",
			after: "Emphasis",
			parse(cx, next, pos) {
				if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
				const before = cx.slice(pos - 1, pos);
				const after = cx.slice(pos + 2, pos + 3);
				return cx.addDelimiter(HighlightDelim, pos, pos + 2, !/\s|^$/.test(after), !/\s|^$/.test(before));
			},
		},
	],
};

// `#tag`: after whitespace or at the start, not all digits. The character
// class is the metadata cache's.
const TAG = /^#[^\s#!@$%^&*(),.?":{}|<>[\]\\`'~;=+]+/;
const hashtagSyntax: MarkdownConfig = {
	defineNodes: [
		{ name: "hashtag" },
		{ name: "hashtag-begin", style: token("cm-formatting cm-formatting-hashtag cm-hashtag cm-hashtag-begin cm-meta") },
		{ name: "hashtag-end", style: token("cm-hashtag cm-hashtag-end cm-meta") },
	],
	parseInline: [
		{
			name: "hashtag",
			before: "Emphasis",
			parse(cx, next, pos) {
				if (next !== 35 || (pos > cx.offset && !isSpace(cx.char(pos - 1)))) return -1;
				const m = TAG.exec(cx.slice(pos, cx.end));
				if (!m || /^#\d+$/.test(m[0])) return -1;
				const end = pos + m[0].length;
				return cx.addElement(cx.elt("hashtag", pos, end, [cx.elt("hashtag-begin", pos, pos + 1), cx.elt("hashtag-end", pos + 1, end)]));
			},
		},
	],
};

// `[[target|alias]]` and `![[embed]]`.
const WIKILINK = /^([^[\]|\n]+)(?:(\|)([^[\]\n]*))?\]\]/;
const wikilinkSyntax: MarkdownConfig = {
	defineNodes: [
		{ name: "internal-link" },
		{ name: "internal-embed" },
		{ name: "formatting-link_formatting-link-start", style: token("cm-formatting cm-formatting-link cm-formatting-link-start") },
		{ name: "formatting-link_formatting-link-start_formatting-embed", style: token("cm-formatting cm-formatting-link cm-formatting-link-start cm-formatting-embed") },
		{ name: "formatting-link_formatting-link-end", style: token("cm-formatting cm-formatting-link cm-formatting-link-end") },
		{ name: "hmd-internal-link", style: token("cm-hmd-internal-link") },
		{ name: "hmd-internal-link_link-alias-pipe", style: token("cm-hmd-internal-link cm-link-alias-pipe") },
		{ name: "hmd-internal-link_link-alias", style: token("cm-hmd-internal-link cm-link-alias") },
	],
	parseInline: [
		{
			name: "internal-link",
			before: "Link",
			parse(cx, next, pos) {
				const embed = next === 33;
				const open = embed ? 3 : 2;
				if (embed ? cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91 : next !== 91 || cx.char(pos + 1) !== 91) return -1;
				const m = WIKILINK.exec(cx.slice(pos + open, cx.end));
				if (!m) return -1;
				let at = pos + open;
				const children = [cx.elt(embed ? "formatting-link_formatting-link-start_formatting-embed" : "formatting-link_formatting-link-start", pos, at)];
				children.push(cx.elt("hmd-internal-link", at, (at += m[1].length)));
				if (m[2]) {
					children.push(cx.elt("hmd-internal-link_link-alias-pipe", at, ++at));
					if (m[3]) children.push(cx.elt("hmd-internal-link_link-alias", at, (at += m[3].length)));
				}
				children.push(cx.elt("formatting-link_formatting-link-end", at, at + 2));
				return cx.addElement(cx.elt(embed ? "internal-embed" : "internal-link", pos, at + 2, children));
			},
		},
	],
};

// Any single character between the brackets is a task status, as in
// Obsidian; GFM only knows `[ ]` and `[x]`.
class TaskParser implements LeafBlockParser {
	nextLine() {
		return false;
	}

	finish(cx: BlockContext, leaf: LeafBlock) {
		cx.addLeafElement(
			leaf,
			cx.elt("Task", leaf.start, leaf.start + leaf.content.length, [
				cx.elt("TaskMarker", leaf.start, leaf.start + 3),
				...cx.parser.parseInline(leaf.content.slice(3), leaf.start + 3),
			]),
		);
		return true;
	}
}

const taskSyntax: MarkdownConfig = {
	parseBlock: [
		{
			name: "TaskList",
			leaf: (cx, leaf) => (/^\[[^\]\n]\][ \t]/.test(leaf.content) && cx.parentType().name === "ListItem" ? new TaskParser() : null),
			after: "SetextHeading",
		},
	],
};

// Obsidian's classes for the marks of built-in syntax, by context.
const formattingClasses: MarkdownConfig = {
	props: [
		styleTags({
			...Object.fromEntries(
				[1, 2, 3, 4, 5, 6].map((n) => [
					`ATXHeading${n}/HeaderMark${n <= 2 ? ` SetextHeading${n}/HeaderMark` : ""}`,
					token(`cm-formatting cm-formatting-header cm-formatting-header-${n}`),
				]),
			),
			"Emphasis/EmphasisMark": token("cm-formatting cm-formatting-em"),
			"StrongEmphasis/EmphasisMark": token("cm-formatting cm-formatting-strong"),
			"Strikethrough/StrikethroughMark": token("cm-formatting cm-formatting-strikethrough"),
			"InlineCode/...": token("cm-inline-code"),
			"InlineCode/CodeMark": token("cm-formatting cm-formatting-code"),
			"FencedCode/CodeText CodeBlock/CodeText": token("cm-hmd-codeblock"),
			"FencedCode/CodeMark FencedCode/CodeInfo": token("cm-formatting cm-formatting-code-block cm-hmd-codeblock"),
			QuoteMark: token("cm-formatting cm-formatting-quote"),
			"BulletList/ListItem/ListMark": token("cm-formatting cm-formatting-list cm-formatting-list-ul"),
			"OrderedList/ListItem/ListMark": token("cm-formatting cm-formatting-list cm-formatting-list-ol"),
			"Task/TaskMarker": token("cm-formatting cm-formatting-task"),
			"Link/LinkMark Image/LinkMark": token("cm-formatting cm-formatting-link"),
			"Link/URL Image/URL": token("cm-string cm-url"),
		}),
	],
};

export const obsidianMarkdown: MarkdownConfig[] = [
	frontmatterSyntax,
	mathSyntax,
	commentSyntax,
	highlightSyntax,
	hashtagSyntax,
	wikilinkSyntax,
	taskSyntax,
	formattingClasses,
];

const obsidianHighlight = HighlightStyle.define([
	{ tag: t.heading1, class: "cm-header cm-header-1" },
	{ tag: t.heading2, class: "cm-header cm-header-2" },
	{ tag: t.heading3, class: "cm-header cm-header-3" },
	{ tag: t.heading4, class: "cm-header cm-header-4" },
	{ tag: t.heading5, class: "cm-header cm-header-5" },
	{ tag: t.heading6, class: "cm-header cm-header-6" },
	{ tag: t.strong, class: "cm-strong" },
	{ tag: t.emphasis, class: "cm-em" },
	{ tag: t.strikethrough, class: "cm-strikethrough" },
	{ tag: t.link, class: "cm-link" },
	{ tag: t.url, class: "cm-url" },
	{ tag: t.quote, class: "cm-quote" },
	{ tag: [t.processingInstruction, t.contentSeparator], class: "cm-formatting" },
	...tokenStyles,
]);

// CodeMirror 5's token classes for code inside fenced blocks, which themes
// style as `.cm-s-obsidian span.cm-keyword` and so on.
const codeHighlight = HighlightStyle.define([
	{ tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], class: "cm-keyword" },
	{ tag: [t.string, t.special(t.string), t.character], class: "cm-string" },
	{ tag: t.regexp, class: "cm-string-2" },
	{ tag: [t.number, t.integer, t.float], class: "cm-number" },
	{ tag: [t.bool, t.null, t.atom, t.unit], class: "cm-atom" },
	{ tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "cm-comment" },
	{ tag: t.variableName, class: "cm-variable" },
	{ tag: [t.definition(t.variableName), t.function(t.definition(t.variableName)), t.className], class: "cm-def" },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], class: "cm-variable-2" },
	{ tag: [t.typeName, t.namespace], class: "cm-type" },
	{ tag: t.propertyName, class: "cm-property" },
	{ tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator], class: "cm-operator" },
	{ tag: [t.standard(t.variableName), t.self], class: "cm-builtin" },
	{ tag: t.meta, class: "cm-meta" },
	{ tag: t.tagName, class: "cm-tag" },
	{ tag: t.attributeName, class: "cm-attribute" },
	{ tag: [t.bracket, t.angleBracket, t.squareBracket, t.paren, t.brace], class: "cm-bracket" },
	{ tag: t.invalid, class: "cm-error" },
]);

// Enter on an empty quote line steps out one quote level, as in Typora,
// instead of CodeMirror's default of continuing the quote.
function exitEmptyQuote(view: EditorView) {
	const { state } = view;
	const sel = state.selection;
	if (sel.ranges.length !== 1 || !sel.main.empty) return false;
	const line = state.doc.lineAt(sel.main.head);
	if (sel.main.head !== line.to || !/^\s*(>\s*)+$/.test(line.text)) return false;
	const outer = line.text.replace(/>\s*$/, "").trimEnd();
	const insert = outer ? `${outer} ` : "";
	view.dispatch({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length }, userEvent: "input" });
	return true;
}

// Tab indents list items and selections, and otherwise inserts one indent
// unit at the cursor, as Obsidian does.
function indentOrInsertTab(view: EditorView) {
	const { state } = view;
	const onList = (pos: number) => {
		for (let n: any = syntaxTree(state).resolveInner(state.doc.lineAt(pos).to, -1); n; n = n.parent) if (n.name === "ListItem") return true;
		return false;
	};
	if (state.selection.ranges.some((r) => !r.empty || onList(r.head))) return indentMore(view);
	view.dispatch(state.replaceSelection(state.facet(indentUnit)), { scrollIntoView: true, userEvent: "input" });
	return true;
}

// Indentation follows the vault's useTab and tabSize settings (Obsidian
// defaults: tabs, 4 columns).
const indentation = new Compartment();
function indentConfig(app: App) {
	const useTab = app.vault.getConfig("useTab") ?? true;
	const tabSize = app.vault.getConfig("tabSize") ?? 4;
	return [indentUnit.of(useTab ? "\t" : " ".repeat(tabSize)), EditorState.tabSize.of(tabSize)];
}

function followConfig(app: App) {
	return ViewPlugin.define((view) => {
		const ref = app.vault.on("config-changed", () => view.dispatch({ effects: indentation.reconfigure(indentConfig(app)) }));
		return { destroy: () => app.vault.offref(ref) };
	});
}

// The CodeMirror configuration of a Markdown editor: language, highlighting,
// keymaps, Live Preview, and the hooks that connect it to its view.
// `plugins` holds the extensions plugins registered.
export function markdownEditorExtensions(view: MarkdownView, plugins: Compartment): Extension[] {
	const app = view.app;
	const host: LivePreviewHost = {
		app,
		sourcePath: () => view.file?.path ?? "",
		resolveImage: (link) => view.resolveImage(link),
	};
	const ext: Extension[] = [
		editorInfoField.init(() => view),
		editorEditorField.init(() => view.editor?.cm ?? null),
		editorLivePreviewField,
		plugins.of(app.workspace.editorExtensions),
		Prec.high(keymap.of([{ key: "Enter", run: exitEmptyQuote }])),
		EditorState.allowMultipleSelections.of(true),
		// Alt-click adds a cursor, as in Obsidian; Mod-click opens links.
		EditorView.clickAddsSelectionRange.of((evt) => evt.altKey),
		indentation.of(indentConfig(app)),
		followConfig(app),
		history(),
		drawSelection(),
		dropCursor(),
		indentOnInput(),
		bracketMatching(),
		closeBrackets(),
		highlightSelectionMatches(),
		search({ top: true }),
		autocompletion({ override: [], activateOnTyping: false }),
		EditorView.lineWrapping,
		markdown({ base: markdownLanguage, codeLanguages: languages, extensions: obsidianMarkdown }),
		livePreview(host),
		livePreviewState,
		syntaxHighlighting(obsidianHighlight),
		syntaxHighlighting(codeHighlight),
		keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, { key: "Tab", run: indentOrInsertTab, shift: indentLess }]),
		EditorView.updateListener.of((u) => {
			const suggest = app.workspace.editorSuggest;
			// Suggests re-check after the update finishes: a suggest that is
			// itself inserting text must not be closed mid-insert.
			const retrigger = () => queueMicrotask(() => suggest.trigger(view.editor, view.file));
			if (u.docChanged) {
				view.requestSave();
				app.workspace.trigger("editor-change", view.editor, view);
				if (u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("delete"))) retrigger();
			} else if (u.selectionSet && suggest.isShowingSuggestion()) {
				retrigger();
			}
			if (u.focusChanged) {
				if (u.view.hasFocus) app.workspace.setActiveLeaf(view.leaf);
				else suggest.close();
			}
		}),
		EditorView.domEventHandlers({
			mousedown: (evt) => view.onLinkClick(evt),
			mouseover: (evt) => {
				const el = (evt.target as HTMLElement).closest?.("[data-href]");
				if (!el) return false;
				app.workspace.trigger("hover-link", {
					event: evt,
					source: "editor",
					hoverParent: view,
					targetEl: el,
					linktext: el.getAttribute("data-href"),
					sourcePath: view.file?.path ?? "",
				});
				return false;
			},
			contextmenu: (evt) => {
				evt.preventDefault();
				view.showContextMenu(evt);
				return true;
			},
			paste: (evt) => {
				app.workspace.trigger("editor-paste", evt, view.editor, view);
				return evt.defaultPrevented;
			},
			drop: (evt) => {
				app.workspace.trigger("editor-drop", evt, view.editor, view);
				return evt.defaultPrevented;
			},
		}),
	];
	if (app.vault.getConfig("showLineNumber")) ext.push(lineNumbers());
	return ext;
}

