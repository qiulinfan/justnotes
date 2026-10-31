import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { cssLanguage } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, codeFolding, foldGutter, foldNodeProp, foldService, HighlightStyle, indentOnInput, indentUnit, Language, languageDataProp, LanguageDescription, LanguageSupport, type LRLanguage, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Extension, Prec, type Range, type StateCommand } from "@codemirror/state";
import { Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, keymap, lineNumbers, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { IterMode, NodeProp, type NodePropSource, type Parser, type SyntaxNode } from "@lezer/common";
import { styleTags, Tag, tags as t } from "@lezer/highlight";
import { type BlockContext, type Element, type LeafBlock, type LeafBlockParser, type Line, type MarkdownConfig, parseCode, parser as commonmark } from "@lezer/markdown";
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

// Blocks whose lines are text even where they hold only quote marks: a line
// of `>` in code, or an empty code line in a quoted fence, is no empty quote
// line.
const textBlocks = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock", "ProcessingInstructionBlock", "BlockMath", "hmd-frontmatter", "comment-block"]);

// Whether the `>` at `pos` belongs to a quote line: the Markdown tree reaches
// a quote from it before any such block. A fenced language's own tree (the
// quotes in a markdown fence) does not count.
function marksQuote(state: EditorState, pos: number) {
	for (let node: SyntaxNode | null = syntaxTree(state).resolve(pos, 1); node; node = node.parent) {
		if (node.name === "Blockquote") return true;
		if (textBlocks.has(node.name)) return false;
	}
	return false;
}

// Enter on an empty quote line steps out one quote level, as in Typora,
// instead of CodeMirror's default of continuing the quote. Text typed right
// below a line of the quote's text would continue that paragraph (a
// CommonMark lazy continuation line) and show inside the quote again, so a
// blank line at the outer level goes between them. Leaving the last level
// keeps the indentation of a list item the quote is in.
export const exitEmptyQuote: StateCommand = ({ state, dispatch }) => {
	const sel = state.selection;
	if (sel.ranges.length !== 1 || !sel.main.empty) return false;
	const line = state.doc.lineAt(sel.main.head);
	if (sel.main.head !== line.to || !/^\s*(>\s*)+$/.test(line.text) || !marksQuote(state, line.from + line.text.lastIndexOf(">"))) return false;
	const outer = line.text.replace(/>\s*$/, "").trimEnd();
	const above = line.number > 1 ? state.doc.line(line.number - 1).text : "";
	const next = outer ? `${outer} ` : line.text.slice(0, line.text.search(/\S/));
	const insert = /[^\s>]/.test(above) ? `${outer}\n${next}` : next;
	dispatch(state.update({ changes: { from: line.from, to: line.to, insert }, selection: { anchor: line.from + insert.length }, userEvent: "input" }));
	return true;
};

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

// What folds, by Obsidian's two settings (both on by default): a heading's
// section (foldHeading) and what is nested in a list item (foldIndent).
// Nothing else does, though lang-markdown folds every block of more than one
// line (paragraphs, quotes, tables, math, code blocks), and the languages of
// fenced code and of HTML (with the CSS and JavaScript in it) fold their own
// syntax.
export interface FoldSettings {
	heading: boolean;
	indent: boolean;
}

const noFold = () => null;

// A list item folds the blocks nested in it (sub-lists, further paragraphs,
// quotes, code) from the end of its first paragraph, whose own lines stay
// like any paragraph's.
function foldListItem(item: SyntaxNode, state: EditorState) {
	const first = item.firstChild?.nextSibling;
	return first?.nextSibling ? { from: state.doc.lineAt(first.to).to, to: item.to } : null;
}

// A language with its folds left out; null for a stream language, which has
// no folds.
const foldlessLanguages = new WeakMap<Language, Language>();
function foldless(lang: Language): Language | null {
	const parser = lang.parser as Parser & { configure?(config: { props: NodePropSource[] }): Parser };
	if (!parser.configure) return null;
	let out = foldlessLanguages.get(lang);
	if (!out) foldlessLanguages.set(lang, (out = new Language(lang.data, parser.configure({ props: [foldNodeProp.add(() => noFold)] }), [], lang.name)));
	return out;
}

// A fenced block's language from language-data with its folds left out, or
// its description while it is not loaded (lang-markdown loads it and parses
// again) and for a stream language, which has no folds. That leaves the folds
// of the languages a fenced one nests, so HTML and Markdown fences get
// versions nesting fold-free ones; Vue, Angular, PHP, Liquid and Jinja fences
// still fold the HTML, CSS and JavaScript in them.
function codeLanguage(info: string): Language | LanguageDescription | null {
	const found = LanguageDescription.matchLanguageName(languages, info, true);
	if (found?.name === "HTML") return htmlFence;
	if (found?.name === "Markdown") return markdownFence;
	const lang = found?.support?.language;
	return (lang && foldless(lang)) ?? found;
}

// A parser lang-html nests, without its folds and starting at rule `top` when
// given.
const foldlessParser = (lang: LRLanguage, top?: string) => lang.parser.configure({ top, props: [foldNodeProp.add(() => noFold)] });

// lang-html's rules for the code in a note's HTML, with the same parsers
// without folds; html() tries them first. A script or a style parses by its
// type or lang (lang-html's own rules, tried after these, test the same, so
// one that none of them matches stays text). A style attribute's value parses
// as CSS and the value of an event handler on lang-html's list (copied from
// lang-html 6.4.12) as JavaScript.
type Attrs = { [attr: string]: string };
const javascriptCode = foldlessParser(javascriptLanguage);
const nestedLanguages = [
	{ tag: "script", attrs: (a: Attrs) => a.type === "text/typescript" || a.lang === "ts", parser: foldlessParser(typescriptLanguage) },
	{ tag: "script", attrs: (a: Attrs) => a.type === "text/babel" || a.type === "text/jsx", parser: foldlessParser(jsxLanguage) },
	{ tag: "script", attrs: (a: Attrs) => a.type === "text/typescript-jsx", parser: foldlessParser(tsxLanguage) },
	{ tag: "script", attrs: (a: Attrs) => /^(importmap|speculationrules|application\/(.+\+)?json)$/i.test(a.type), parser: foldlessParser(javascriptLanguage, "SingleExpression") },
	{ tag: "script", attrs: (a: Attrs) => !a.type || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^module$|^$/i.test(a.type), parser: javascriptCode },
	{ tag: "style", attrs: (a: Attrs) => (!a.lang || a.lang === "css") && (!a.type || /^(text\/)?(x-)?(stylesheet|css)$/i.test(a.type)), parser: foldlessParser(cssLanguage) },
];
const handlers = "beforeunload copy cut dragstart dragover dragleave dragenter dragend drag paste focus blur change click load mousedown mouseenter mouseleave mouseup keydown keyup resize scroll unload";
const nestedAttributes = [{ name: "style", parser: foldlessParser(cssLanguage, "Styles") }, ...handlers.split(" ").map((name) => ({ name: `on${name}`, parser: javascriptCode }))];

// HTML with no folds of its own or of the code in it.
function foldlessHtml(matchClosingTags: boolean) {
	const support = html({ matchClosingTags, nestedLanguages, nestedAttributes });
	return new LanguageSupport(foldless(support.language)!, support.support);
}

// HTML in a note, as lang-markdown parses it (closing tags not matched), and
// in an html fence, as language-data does.
const htmlTags = foldlessHtml(false);
const htmlFence = foldlessHtml(true).language;

// A markdown fence parses as language-data's Markdown does (CommonMark, with
// HTML, and Markdown's language data), from lezer's parser without
// lang-markdown's folds and heading marks: its heading folds would take the
// fence's headings for the note's.
const markdownFence = new Language(
	markdownLanguage.data,
	commonmark.configure([parseCode({ htmlParser: htmlTags.language.parser }), { props: [languageDataProp.add({ Document: markdownLanguage.data })] }]),
	[],
	"markdown",
);

// The Markdown language with Obsidian's syntax and folds.
export function markdownSupport(fold: FoldSettings): Extension {
	const blockFolds: MarkdownConfig = {
		props: [
			foldNodeProp.add((type) => {
				if (!type.is("Block")) return undefined;
				return fold.indent && type.name === "ListItem" ? foldListItem : noFold;
			}),
		],
	};
	const md = markdown({ base: markdownLanguage, codeLanguages: codeLanguage, htmlTagLanguage: htmlTags, extensions: [...obsidianMarkdown, blockFolds] });
	if (fold.heading) return md;
	// lang-markdown folds heading sections with a fold service among its support extensions.
	const support = Array.isArray(md.support) ? md.support : [md.support];
	return [md.language, support.filter((ext: Extension) => !EditorState.create({ extensions: ext }).facet(foldService).length)];
}

// Folds open and close from a chevron in the gutter.
function folding(fold: FoldSettings): Extension[] {
	if (!fold.heading && !fold.indent) return [];
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

// A Markdown editor that belongs to no MarkdownView (a canvas card being
// edited): the language, Live Preview, highlighting and the editing keymaps,
// with links and embeds resolved from `host.sourcePath()`. Nothing folds.
export function embeddedMarkdownExtensions(host: LivePreviewHost): Extension[] {
	return [
		editorLivePreviewField,
		Prec.high(keymap.of([{ key: "Enter", run: exitEmptyQuote }])),
		indentation.of(indentConfig(host.app)),
		history(),
		drawSelection(),
		dropCursor(),
		indentOnInput(),
		bracketMatching(),
		closeBrackets(),
		EditorView.lineWrapping,
		markdownSupport({ heading: false, indent: false }),
		livePreview(host),
		livePreviewState,
		syntaxHighlighting(obsidianHighlight),
		syntaxHighlighting(codeHighlight),
		highlightedCode,
		keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, { key: "Tab", run: indentOrInsertTab, shift: indentLess }]),
	];
}

// The CodeMirror configuration of a Markdown editor: language, highlighting,
// keymaps, Live Preview, and the hooks that connect it to its view.
// `plugins` holds the extensions plugins registered.
export function markdownEditorExtensions(view: MarkdownView, plugins: Compartment): Extension[] {
	const app = view.app;
	followVault(view);
	const fold: FoldSettings = { heading: app.vault.getConfig("foldHeading") ?? true, indent: app.vault.getConfig("foldIndent") ?? true };
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
		markdownSupport(fold),
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
		// The editor menu opens over the gutters too, as in Obsidian (obsidian-git
		// adds its line author items there); domEventHandlers only see the content,
		// where CodeMirror passes over a right-click something already handled (the
		// link menu of a rendered callout), and so does this.
		ViewPlugin.define((cm) => {
			const onContextMenu = (evt: MouseEvent) => {
				if (evt.defaultPrevented || !(evt.target as HTMLElement).closest?.(".cm-gutters")) return;
				evt.preventDefault();
				view.showContextMenu(evt);
			};
			cm.dom.addEventListener("contextmenu", onContextMenu);
			return { destroy: () => cm.dom.removeEventListener("contextmenu", onContextMenu) };
		}),
	];
	if (app.vault.getConfig("showLineNumber")) ext.push(lineNumbers());
	ext.push(folding(fold));
	return ext;
}

