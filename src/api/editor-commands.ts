import { isolateHistory } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { type ChangeSpec, EditorSelection, type EditorState, type SelectionRange, type TransactionSpec } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { type Editor, selectedLines } from "./editor";

// Edits behind Obsidian's built-in editor commands. Each takes the editor
// state and returns one transaction covering every selection range, so a
// command is one undo step.
export type StateEdit = (state: EditorState) => TransactionSpec | null;

export function runEdit(editor: Editor, edit: StateEdit) {
	const spec = edit(editor.cm.state);
	if (!spec) return false;
	editor.cm.dispatch({ ...spec, scrollIntoView: true, annotations: isolateHistory.of("full") });
	return true;
}

interface Markup {
	open: string;
	close: string;
	nodes: string[];
}

export const MARKUP = {
	bold: { open: "**", close: "**", nodes: ["StrongEmphasis"] },
	italic: { open: "*", close: "*", nodes: ["Emphasis"] },
	strikethrough: { open: "~~", close: "~~", nodes: ["Strikethrough"] },
	highlight: { open: "==", close: "==", nodes: ["highlight"] },
	code: { open: "`", close: "`", nodes: ["InlineCode"] },
	math: { open: "$", close: "$", nodes: ["InlineMath"] },
	comment: { open: "%%", close: "%%", nodes: ["comment"] },
} satisfies Record<string, Markup>;

// The innermost span of one of `names` around the range: strictly around a
// cursor, or containing a selection.
function enclosing(state: EditorState, range: SelectionRange, names: string[]): SyntaxNode | null {
	const tree = syntaxTree(state);
	for (const side of [1, -1] as const) {
		for (let n: SyntaxNode | null = tree.resolveInner(range.empty ? range.head : range.from, side); n; n = n.parent) {
			if (!names.includes(n.name)) continue;
			if (range.empty ? n.from < range.head && range.head < n.to : n.from <= range.from && range.to <= n.to) return n;
		}
	}
	return null;
}

// The opening and closing marks of a formatted span.
function marksOf(node: SyntaxNode, markup: Markup): ChangeSpec[] {
	const first = node.firstChild;
	const last = node.lastChild;
	const open = first && last && first !== last && first.from === node.from ? first.to - first.from : markup.open.length;
	const close = first && last && first !== last && last.to === node.to ? last.to - last.from : markup.close.length;
	return [
		{ from: node.from, to: node.from + open },
		{ from: node.to - close, to: node.to },
	];
}

// Toggle bold, italics and the other inline markup: unwrap the span around
// the cursor or selection, otherwise wrap the selection (without its outer
// whitespace) or the word at the cursor, or insert an empty pair.
export function toggleMarkup(markup: Markup): StateEdit {
	return (state) =>
		state.changeByRange((range) => {
			const node = enclosing(state, range, markup.nodes);
			if (node) {
				const changes = state.changes(marksOf(node, markup));
				return { changes, range: range.map(changes) };
			}
			let { from, to } = range;
			if (range.empty) {
				const word = state.wordAt(range.head);
				if (!word) {
					return {
						changes: { from, insert: markup.open + markup.close },
						range: EditorSelection.cursor(from + markup.open.length),
					};
				}
				({ from, to } = word);
			} else {
				const text = state.sliceDoc(from, to);
				from += text.length - text.trimStart().length;
				to -= text.length - text.trimEnd().length;
				if (from >= to) return { range };
			}
			const changes = state.changes([
				{ from, insert: markup.open },
				{ from: to, insert: markup.close },
			]);
			const shift = markup.open.length;
			return {
				changes,
				range: range.empty ? EditorSelection.cursor(range.head + shift) : EditorSelection.range(from + shift, to + shift),
			};
		});
}

const FORMATTING = new Map<string, Markup>([
	["StrongEmphasis", MARKUP.bold],
	["Emphasis", MARKUP.italic],
	["Strikethrough", MARKUP.strikethrough],
	["highlight", MARKUP.highlight],
	["InlineCode", MARKUP.code],
]);

// Remove bold, italics, strikethrough, highlight and inline code inside the
// selection, or around the cursor.
export const clearFormatting: StateEdit = (state) => {
	const tree = syntaxTree(state);
	const spans = new Map<string, SyntaxNode>();
	const add = (n: SyntaxNode) => spans.set(`${n.from}:${n.to}`, n);
	for (const range of state.selection.ranges) {
		for (const side of [1, -1] as const) {
			for (let n: SyntaxNode | null = tree.resolveInner(range.empty ? range.head : range.from, side); n; n = n.parent) {
				if (!FORMATTING.has(n.name)) continue;
				if (range.empty ? n.from < range.head && range.head < n.to : n.from <= range.from && range.to <= n.to) add(n);
			}
		}
		if (range.empty) continue;
		tree.iterate({
			from: range.from,
			to: range.to,
			enter: (n) => {
				if (FORMATTING.has(n.name) && n.to > range.from && n.from < range.to) add(n.node);
			},
		});
	}
	const changes = [...spans.values()].flatMap((node) => marksOf(node, FORMATTING.get(node.name)!));
	if (!changes.length) return null;
	const set = state.changes(changes);
	return { changes: set, selection: state.selection.map(set) };
};

const URL_TEXT = /^[a-z][\w+.-]*:\/\/\S+$/i;

// `[selection]()` with the cursor in the parentheses; a selected URL becomes
// `[](url)` with the cursor in the brackets.
export const insertMarkdownLink: StateEdit = (state) =>
	state.changeByRange((range) => {
		const text = state.sliceDoc(range.from, range.to);
		if (URL_TEXT.test(text.trim())) {
			return { changes: { from: range.from, to: range.to, insert: `[](${text.trim()})` }, range: EditorSelection.cursor(range.from + 1) };
		}
		const insert = `[${text}]()`;
		return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + (text ? insert.length - 1 : 1)) };
	});

// `[[selection]]` (or `![[…]]`) with the cursor before the closing brackets,
// where the link suggest picks it up.
export function insertWikilink(embed: boolean): StateEdit {
	const open = embed ? "![[" : "[[";
	return (state) =>
		state.changeByRange((range) => {
			const text = state.sliceDoc(range.from, range.to);
			return { changes: { from: range.from, to: range.to, insert: `${open}${text}]]` }, range: EditorSelection.cursor(range.from + open.length + text.length) };
		});
}

export const insertTagMarker: StateEdit = (state) =>
	state.changeByRange((range) => {
		const text = state.sliceDoc(range.from, range.to).replace(/\s+/g, "-");
		return { changes: { from: range.from, to: range.to, insert: `#${text}` }, range: EditorSelection.cursor(range.from + 1 + text.length) };
	});

// A line's prefix: indentation with any quote markers, then an optional
// list marker and task box.
interface LineParts {
	indent: string;
	marker: string;
	space: string;
	task: string | undefined;
	body: number;
}

const PREFIX = /^((?:[ \t]*>)*[ \t]*)(?:([-*+]|\d+[.)])([ \t]+|$)(?:\[(.)\](?=[ \t]|$)[ \t]?)?)?/;

export function lineParts(text: string): LineParts {
	const m = PREFIX.exec(text)!;
	return { indent: m[1], marker: m[2] ?? "", space: m[3] ?? "", task: m[4], body: m[0].length };
}

type LineEdit = (text: string, index: number, lines: string[]) => { from: number; to: number; insert: string }[] | null;

// Apply `edit` to each selected line (empty lines are skipped when several
// lines are selected). A cursor at an insertion point moves past it; a
// selection keeps covering the lines it covered, prefixes included.
function editLines(state: EditorState, edit: LineEdit): TransactionSpec | null {
	let numbers = selectedLines(state);
	if (numbers.length > 1) numbers = numbers.filter((n) => state.doc.line(n + 1).text.trim() !== "");
	const lines = numbers.map((n) => state.doc.line(n + 1).text);
	const changes: ChangeSpec[] = [];
	numbers.forEach((n, i) => {
		const line = state.doc.line(n + 1);
		for (const c of edit(line.text, i, lines) ?? []) changes.push({ from: line.from + c.from, to: line.from + c.to, insert: c.insert });
	});
	if (!changes.length) return null;
	const set = state.changes(changes);
	const ranges = state.selection.ranges.map((r) => {
		if (r.empty) return EditorSelection.cursor(set.mapPos(r.head, 1));
		const forward = r.anchor < r.head;
		return EditorSelection.range(set.mapPos(r.anchor, forward ? -1 : 1), set.mapPos(r.head, forward ? 1 : -1));
	});
	return { changes: set, selection: EditorSelection.create(ranges, state.selection.mainIndex) };
}

// Mod+L: check or uncheck a task, and turn other lines into tasks.
export const toggleChecklistStatus: StateEdit = (state) =>
	editLines(state, (text) => {
		const p = lineParts(text);
		if (p.task !== undefined) {
			const at = p.indent.length + p.marker.length + p.space.length + 1;
			return [{ from: at, to: at + 1, insert: p.task === " " ? "x" : " " }];
		}
		if (p.marker) {
			const at = p.indent.length + p.marker.length;
			return [{ from: at, to: at + p.space.length, insert: " [ ] " }];
		}
		return [{ from: p.indent.length, to: p.indent.length, insert: "- [ ] " }];
	});

// Plain line, then bullet, then task, then plain again.
export const cycleListChecklist: StateEdit = (state) =>
	editLines(state, (text) => {
		const p = lineParts(text);
		if (p.task !== undefined) return [{ from: p.indent.length, to: p.body, insert: "" }];
		if (p.marker) {
			const at = p.indent.length + p.marker.length;
			return [{ from: at, to: at + p.space.length, insert: " [ ] " }];
		}
		return [{ from: p.indent.length, to: p.indent.length, insert: "- " }];
	});

const isBullet = (p: LineParts) => /^[-*+]$/.test(p.marker);

// Whether every non-empty selected line passes, and there is one.
function everyLine(state: EditorState, test: (text: string) => boolean) {
	const lines = selectedLines(state)
		.map((n) => state.doc.line(n + 1).text)
		.filter((t) => t.trim());
	return lines.length > 0 && lines.every(test);
}
const isNumbered = (p: LineParts) => /^\d/.test(p.marker);

// Remove the bullets when every line has one, otherwise make every line a
// bullet item (keeping task boxes).
export const toggleBulletList: StateEdit = (state) => {
	const all = everyLine(state, (text) => isBullet(lineParts(text)));
	return editLines(state, (text) => {
		const p = lineParts(text);
		const start = p.indent.length;
		if (all) return [{ from: start, to: start + p.marker.length + p.space.length, insert: "" }];
		if (isBullet(p)) return null;
		return [{ from: start, to: start + p.marker.length + p.space.length, insert: "- " }];
	});
};

// The same for numbered lists, numbering the selected lines from 1.
export const toggleNumberedList: StateEdit = (state) => {
	const all = everyLine(state, (text) => isNumbered(lineParts(text)));
	return editLines(state, (text, i) => {
		const p = lineParts(text);
		const start = p.indent.length;
		const end = start + p.marker.length + p.space.length;
		return [{ from: start, to: end, insert: all ? "" : `${i + 1}. ` }];
	});
};

// Remove one quote level when every line is quoted, otherwise quote them.
export const toggleBlockquote: StateEdit = (state) => {
	const all = everyLine(state, (text) => /^[ \t]*>/.test(text));
	return editLines(state, (text) => {
		if (!all) return [{ from: 0, to: 0, insert: "> " }];
		const m = /^[ \t]*> ?/.exec(text);
		return m ? [{ from: 0, to: m[0].length, insert: "" }] : null;
	});
};

// Replace any ATX heading marks with `level` of them; 0 removes them.
export function setHeading(level: number): StateEdit {
	return (state) =>
		editLines(state, (text) => {
			const m = /^#{1,6}(?:[ \t]+|$)/.exec(text);
			const insert = level ? `${"#".repeat(level)} ` : "";
			const to = m ? m[0].length : 0;
			return text.slice(0, to) === insert ? null : [{ from: 0, to, insert }];
		});
}

// A block snippet on its own lines: at the cursor line when it is empty,
// otherwise below it. `cursor` is the cursor offset inside `text`.
function insertBlock(text: string, cursor: number): StateEdit {
	return (state) =>
		state.changeByRange((range) => {
			const line = state.doc.lineAt(range.head);
			const empty = !line.text.trim();
			const from = empty ? line.from : line.to;
			const insert = empty ? text : `\n${text}`;
			return {
				changes: { from, to: line.to, insert },
				range: EditorSelection.cursor(from + (empty ? 0 : 1) + cursor),
			};
		});
}

// Wrap the selected lines between `open` and `close` lines, with the cursor
// after `open`; with no selection, insert an empty block.
function wrapLines(open: string, close: string): StateEdit {
	const empty = insertBlock(`${open}\n\n${close}`, open.length);
	return (state) => {
		if (state.selection.ranges.every((r) => r.empty)) return empty(state);
		return state.changeByRange((range) => {
			if (range.empty) return { range };
			const first = state.doc.lineAt(range.from);
			const last = state.doc.lineAt(range.to);
			return {
				changes: [
					{ from: first.from, insert: `${open}\n` },
					{ from: last.to, insert: `\n${close}` },
				],
				range: EditorSelection.cursor(first.from + open.length),
			};
		});
	};
}

export const insertCodeBlock = wrapLines("```", "```");
export const insertMathBlock: StateEdit = (state) => {
	if (state.selection.ranges.some((r) => !r.empty)) return wrapLines("$$", "$$")(state);
	return insertBlock("$$\n\n$$", 3)(state);
};

// A note callout; selected lines become its body.
export const insertCallout: StateEdit = (state) =>
	state.changeByRange((range) => {
		const head = "> [!note]";
		if (range.empty) {
			const line = state.doc.lineAt(range.head);
			const body = line.text.trim();
			const insert = `${head}\n> ${body}`;
			return { changes: { from: line.from, to: line.to, insert }, range: EditorSelection.cursor(line.from + insert.length) };
		}
		const first = state.doc.lineAt(range.from);
		const last = state.doc.lineAt(range.to);
		const body = state
			.sliceDoc(first.from, last.to)
			.split("\n")
			.map((l) => `> ${l}`)
			.join("\n");
		const insert = `${head}\n${body}`;
		return { changes: { from: first.from, to: last.to, insert }, range: EditorSelection.cursor(first.from + insert.length) };
	});

export const insertTable = insertBlock("|     |     |\n| --- | --- |\n|     |     |", 2);
