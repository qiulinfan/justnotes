import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, codeFolding, foldGutter, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension, Prec, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, keymap, lineNumbers, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { IterMode, NodeProp, type SyntaxNode } from "@lezer/common";
import { styleTags, Tag, tags as t } from "@lezer/highlight";
import type { BlockContext, Element, LeafBlock, LeafBlockParser, Line, MarkdownConfig } from "@lezer/markdown";
import type { App } from "./app";
import { editorEditorField, editorInfoField, editorLivePreviewField } from "./editor";
import { setIcon } from "./icons";
import { type LivePreviewHost, livePreview, livePreviewState, refreshLivePreview } from "./live-preview";
import { inlineMathEnd, mathBlockClose } from "./markdown";
import type { MarkdownView } from "./markdown-view";
import { debounce, moment } from "./util";
import type { TFile } from "./vault";

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

const mathTag = token("cm-math");
const DOLLAR = 36;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

// How many of the blocks around the parse (quotes, list items) a line
// continues; lezer's own parsers read Line.depth, which it does not type.
const continuedBlocks = (line: Line) => (line as Line & { depth: number }).depth;

const MATH_BEGIN = "formatting_formatting-math_formatting-math-begin_keyword_math";
const MATH_END = "formatting_formatting-math_formatting-math-end_keyword_math";
const MATH_BLOCK_BEGIN = `${MATH_BEGIN}_math-block`;
const MATH_BLOCK_END = `${MATH_END}_math-block`;

// `$…$`, `$$…$$` and `$$` blocks by the renderer's rules (inlineMathEnd,
// mathBlockClose), so Live Preview renders the formulas the reading view
// renders. A block inside a quote keeps the quote marks of its lines as
// children of its math node.
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
				const text = cx.slice(pos, cx.end);
				const length = inlineMathEnd(text, 0, text.length);
				if (length < 0) return -1;
				const fence = text.charCodeAt(1) === DOLLAR ? 2 : 1;
				const end = pos + length;
				const [begin, close] = fence === 2 ? [MATH_BLOCK_BEGIN, MATH_BLOCK_END] : [MATH_BEGIN, MATH_END];
				return cx.addElement(cx.elt("InlineMath", pos, end, [cx.elt(begin, pos, pos + fence), cx.elt("math", pos + fence, end - fence), cx.elt(close, end - fence, end)]));
			},
		},
	],
	parseBlock: [
		{
			name: "BlockMath",
			before: "FencedCode",
			parse(cx, line) {
				const firstClose = line.next === DOLLAR ? mathBlockClose(line.text.slice(line.pos)) : null;
				if (firstClose === null) return false;
				const start = cx.lineStart + line.pos;
				const marks: Element[] = [];
				let close = firstClose >= 0 ? start + firstClose : -1;
				let end = cx.lineStart + line.text.length;
				// Whether the parser still stands on a line of the block: the block
				// can also end where its quote or list does, or with the note.
				let onBlock = true;
				while (close < 0) {
					if (!cx.nextLine() || continuedBlocks(line) < cx.depth) {
						onBlock = false;
						break;
					}
					marks.push(...line.markers);
					end = cx.lineStart + line.text.length;
					const at = line.text.indexOf("$$", line.pos);
					if (at >= 0) close = cx.lineStart + at;
				}
				if (onBlock) cx.nextLine();
				const children = [cx.elt(MATH_BLOCK_BEGIN, start, start + 2)];
				const contentEnd = close >= 0 ? close : end;
				if (contentEnd > start + 2) children.push(cx.elt("math", start + 2, contentEnd, marks));
				if (close >= 0) children.push(cx.elt(MATH_BLOCK_END, close, close + 2));
				cx.addElement(cx.elt("BlockMath", start, close >= 0 ? close + 2 : end, children));
				return true;
			},
			// A `$$` line ends a paragraph, as in the renderer.
			endLeaf: (_cx, line) => line.next === DOLLAR && mathBlockClose(line.text.slice(line.pos)) !== null,
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

// A footnote definition is a paragraph, not a link reference definition.
// This parser runs first and drops the ones after it: the link reference
// parser would otherwise claim `[^1]: word`.
class FootnoteDefinitionParser implements LeafBlockParser {
	nextLine(_cx: BlockContext, _line: unknown, leaf: LeafBlock) {
		leaf.parsers.splice(leaf.parsers.indexOf(this) + 1);
		return false;
	}

	finish(cx: BlockContext, leaf: LeafBlock) {
		cx.addLeafElement(leaf, cx.elt("Paragraph", leaf.start, leaf.start + leaf.content.length, cx.parser.parseInline(leaf.content, leaf.start)));
		return true;
	}
}

// Footnote references and definition labels, `[^id]`, which lezer-markdown
// reads as reference links.
const footnoteSyntax: MarkdownConfig = {
	defineNodes: [{ name: "footref", style: token("cm-footref") }],
	parseBlock: [
		{
			name: "footnote-definition",
			before: "LinkReference",
			leaf: (_cx, leaf) => (/^\[\^[^\s[\]^]+\]:/.test(leaf.content) ? new FootnoteDefinitionParser() : null),
		},
	],
	parseInline: [
		{
			name: "footref",
			before: "Link",
			parse(cx, next, pos) {
				if (next !== 91 || cx.char(pos + 1) !== 94) return -1;
				const m = /^\[\^[^\s[\]^]+\]/.exec(cx.slice(pos, cx.end));
				return m ? cx.addElement(cx.elt("footref", pos, pos + m[0].length)) : -1;
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
	footnoteSyntax,
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
	{ tag: [t.string, t.special(t.string)], class: "cm-string" },
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
		for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(state.doc.lineAt(pos).to, -1); n; n = n.parent) if (n.name === "ListItem") return true;
		return false;
	};
	if (state.selection.ranges.some((r) => !r.empty || onList(r.head))) return indentMore(view);
	view.dispatch(state.replaceSelection(state.facet(indentUnit)), { scrollIntoView: true, userEvent: "input" });
	return true;
}

// Obsidian marks each line holding a cursor with .cm-active.
const activeLineDeco = Decoration.line({ class: "cm-active" });
const activeLine = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(u: ViewUpdate) {
			if (u.docChanged || u.selectionSet) this.decorations = this.build(u.view);
		}

		build(view: EditorView) {
			const starts = new Set(view.state.selection.ranges.map((r) => view.state.doc.lineAt(r.head).from));
			return Decoration.set([...starts].map((from) => activeLineDeco.range(from)), true);
		}
	},
	{ decorations: (v) => v.decorations },
);

// Headings and lists fold from a chevron in the gutter, as with Obsidian's
// foldHeading and foldIndent options (both on by default).
function folding(app: App): Extension[] {
	if (!(app.vault.getConfig("foldHeading") ?? true) && !(app.vault.getConfig("foldIndent") ?? true)) return [];
	return [
		codeFolding(),
		foldGutter({
			markerDOM(open) {
				const el = createDiv({ cls: open ? "cm-fold-indicator" : "cm-fold-indicator is-collapsed" });
				setIcon(el.createDiv({ cls: open ? "collapse-indicator collapse-icon" : "collapse-indicator collapse-icon is-collapsed" }), "chevron-down");
				return el;
			},
		}),
	];
}

// Highlighted code is a nested language tree, so its tokens miss the
// cm-hmd-codeblock class that Obsidian gives every token in a code block.
// An outer mark adds it without covering the token classes.
const codeBlockMark = Decoration.mark({ class: "cm-hmd-codeblock" });
const highlightedCode = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = this.build(view);
		}

		update(u: ViewUpdate) {
			if (u.docChanged || u.viewportChanged || syntaxTree(u.state) !== syntaxTree(u.startState)) this.decorations = this.build(u.view);
		}

		build(view: EditorView) {
			const marks: Range<Decoration>[] = [];
			syntaxTree(view.state).iterate({
				...view.viewport,
				mode: IterMode.IgnoreMounts,
				enter: (node) => {
					if (node.name !== "FencedCode") return;
					if (node.tree?.prop(NodeProp.mounted)) for (const text of node.node.getChildren("CodeText")) marks.push(codeBlockMark.range(text.from, text.to));
					return false;
				},
			});
			return Decoration.set(marks);
		}
	},
	{ provide: (plugin) => EditorView.outerDecorations.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none) },
);

// Indentation follows the vault's useTab and tabSize settings (Obsidian
// defaults: tabs, 4 columns).
const indentation = new Compartment();
function indentConfig(app: App) {
	const useTab = app.vault.getConfig("useTab") ?? true;
	const tabSize = app.vault.getConfig("tabSize") ?? 4;
	return [indentUnit.of(useTab ? "\t" : " ".repeat(tabSize)), EditorState.tabSize.of(tabSize)];
}

// A view's editor follows the vault: its indentation settings, and the files
// that links and images resolve to. The view subscribes once and unsubscribes
// when it closes; a subscription per editor state would outlive a closed tab
// whose editor is never destroyed.
const following = new WeakSet<MarkdownView>();
function followVault(view: MarkdownView) {
	if (following.has(view)) return;
	following.add(view);
	const { app } = view;
	const editor = () => view.editor?.cm;
	view.registerEvent(app.vault.on("config-changed", () => editor()?.dispatch({ effects: indentation.reconfigure(indentConfig(app)) })));
	const filesChanged = debounce(
		() => {
			const cm = editor();
			if (cm) refreshLivePreview(cm);
		},
		300,
		true,
	);
	for (const name of ["create", "delete", "rename"]) view.registerEvent(app.vault.on(name, filesChanged));
	// An edited image gets a new resource URL.
	view.registerEvent(app.vault.on("modify", (file: TFile) => file.extension !== "md" && filesChanged()));
	view.register(() => filesChanged.cancel());
}

// Obsidian's own paste and drop handling, after plugins had their turn:
// files become attachments next to the note, and a URL pasted over
// selected text links that text.
const EMBEDDABLE = /^(png|jpe?g|gif|svg|webp|bmp|avif|mp3|wav|m4a|ogg|flac|mp4|webm|ogv|mov|mkv|pdf)$/i;
const URL_ONLY = /^[a-z][\w+.-]*:\/\/\S+$/i;

async function attach(view: MarkdownView, files: File[], pasted: boolean) {
	const { app } = view;
	const sourcePath = view.file?.path ?? "";
	const webUtils = require("electron").webUtils;
	const links: string[] = [];
	for (const file of files) {
		// A file dragged from inside the vault is linked, not copied.
		const disk: string | undefined = webUtils?.getPathForFile?.(file);
		const base = app.vault.adapter.basePath;
		let target: TFile | null = disk?.startsWith(`${base}/`) ? app.vault.getFileByPath(disk.slice(base.length + 1)) : null;
		if (!target) {
			const ext = /\.([^.]+)$/.exec(file.name)?.[1] ?? file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
			const name = pasted && file.type.startsWith("image/") ? `Pasted image ${moment().format("YYYYMMDDHHmmss")}.${ext}` : file.name;
			const path = await app.fileManager.getAvailablePathForAttachment(name, sourcePath);
			target = await app.vault.createBinary(path, await file.arrayBuffer());
		}
		const link = app.fileManager.generateMarkdownLink(target, sourcePath);
		links.push(EMBEDDABLE.test(target.extension) ? `!${link}` : link);
	}
	view.editor.replaceSelection(links.join("\n"), "input.paste");
}

function pasteDefault(view: MarkdownView, evt: ClipboardEvent) {
	const data = evt.clipboardData;
	if (!data) return false;
	if (data.files.length) {
		attach(view, [...data.files], true).catch((err) => console.error(err));
		return true;
	}
	const url = data.getData("text/plain").trim();
	const { state } = view.editor.cm;
	const linkable = (r: { from: number; to: number; empty: boolean }) =>
		!r.empty && state.doc.lineAt(r.from).number === state.doc.lineAt(r.to).number && !URL_ONLY.test(state.sliceDoc(r.from, r.to).trim());
	if (!URL_ONLY.test(url) || !state.selection.ranges.every(linkable)) return false;
	view.editor.cm.dispatch(
		state.changeByRange((r) => {
			const insert = `[${state.sliceDoc(r.from, r.to)}](${url})`;
			return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.cursor(r.from + insert.length) };
		}),
		{ userEvent: "input.paste" },
	);
	return true;
}

function dropDefault(view: MarkdownView, evt: DragEvent) {
	const files = [...(evt.dataTransfer?.files ?? [])];
	if (!files.length) return false;
	const pos = view.editor.cm.posAtCoords({ x: evt.clientX, y: evt.clientY });
	if (pos !== null) view.editor.cm.dispatch({ selection: { anchor: pos } });
	attach(view, files, false).catch((err) => console.error(err));
	return true;
}

// The CodeMirror configuration of a Markdown editor: language, highlighting,
// keymaps, Live Preview, and the hooks that connect it to its view.
// `plugins` holds the extensions plugins registered.
export function markdownEditorExtensions(view: MarkdownView, plugins: Compartment): Extension[] {
	const app = view.app;
	followVault(view);
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
		activeLine,
		syntaxHighlighting(obsidianHighlight),
		syntaxHighlighting(codeHighlight),
		highlightedCode,
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
				if (evt.defaultPrevented) return true;
				if (!pasteDefault(view, evt)) return false;
				evt.preventDefault();
				return true;
			},
			drop: (evt) => {
				app.workspace.trigger("editor-drop", evt, view.editor, view);
				if (evt.defaultPrevented) return true;
				if (!dropDefault(view, evt)) return false;
				evt.preventDefault();
				return true;
			},
		}),
	];
	if (app.vault.getConfig("showLineNumber")) ext.push(lineNumbers());
	ext.push(folding(app));
	return ext;
}

