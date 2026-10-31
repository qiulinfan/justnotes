import * as cmCommands from "@codemirror/commands";
import { foldAll, toggleFold, unfoldAll } from "@codemirror/language";
import { type ChangeSpec, EditorSelection, type EditorState, StateEffect, StateField, type Text, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { type ClickableToken, clickableTokenAt } from "./live-preview";

export { livePreviewState } from "./live-preview";

export interface EditorPosition {
	line: number;
	ch: number;
}

export interface EditorRange {
	from: EditorPosition;
	to: EditorPosition;
}

export interface EditorRangeOrCaret {
	from: EditorPosition;
	to?: EditorPosition;
}

export interface EditorSelectionRange {
	anchor: EditorPosition;
	head: EditorPosition;
}

export interface EditorSelectionOrCaret {
	anchor: EditorPosition;
	head?: EditorPosition;
}

export interface EditorChange extends EditorRangeOrCaret {
	text: string;
}

export interface EditorTransaction {
	replaceSelection?: string;
	changes?: EditorChange[];
	selections?: EditorRangeOrCaret[];
	selection?: EditorRangeOrCaret;
}

export type EditorCommandName =
	| "goUp"
	| "goDown"
	| "goLeft"
	| "goRight"
	| "goStart"
	| "goEnd"
	| "goWordLeft"
	| "goWordRight"
	| "indentMore"
	| "indentLess"
	| "newlineAndIndent"
	| "swapLineUp"
	| "swapLineDown"
	| "deleteLine"
	| "toggleFold"
	| "foldAll"
	| "unfoldAll";

// State fields Obsidian exposes so CM6 extensions can find their editor.
const setInfo = StateEffect.define<any>();
const setView = StateEffect.define<EditorView>();

export const editorInfoField = StateField.define<any>({
	create: () => null,
	update: (v, tr) => tr.effects.find((e) => e.is(setInfo))?.value ?? v,
});
export const editorViewField = editorInfoField;
export const editorEditorField = StateField.define<EditorView>({
	create: () => null as unknown as EditorView,
	update: (v, tr) => tr.effects.find((e) => e.is(setView))?.value ?? v,
});
// justnotes has only Live Preview, so this never turns false.
export const editorLivePreviewField = StateField.define<boolean>({
	create: () => true,
	update: (v) => v,
});

export function bindEditorFields(view: EditorView, info: any) {
	view.dispatch({ effects: [setView.of(view), setInfo.of(info)] });
}

// CodeMirror 5's clipPos, which Obsidian's Editor keeps: a line before the
// first is the document start, a line past the last is the document end, and
// ch is clamped to the line (a missing ch means the line end).
export function posToOffset(doc: Text, pos: EditorPosition) {
	if (!(pos.line >= 0)) return 0;
	if (pos.line >= doc.lines) return doc.length;
	const line = doc.line(Math.floor(pos.line) + 1);
	if (pos.ch < 0) return line.from;
	return pos.ch <= line.length ? line.from + pos.ch : line.to;
}

export function offsetToPos(doc: Text, offset: number): EditorPosition {
	const clamped = offset > 0 ? Math.min(offset, doc.length) : 0;
	const line = doc.lineAt(clamped);
	return { line: line.number - 1, ch: clamped - line.from };
}

// One CodeMirror transaction for an EditorTransaction: `changes` and the
// replaced selection are positions in the current document, the new
// selection is read in the document those changes produce.
export function transactionSpec(state: EditorState, tx: EditorTransaction): TransactionSpec {
	const doc = state.doc;
	const specs: ChangeSpec[] = [];
	for (const c of tx.changes ?? []) {
		const a = posToOffset(doc, c.from);
		const b = c.to ? posToOffset(doc, c.to) : a;
		specs.push({ from: Math.min(a, b), to: Math.max(a, b), insert: c.text });
	}
	const ranges = state.selection.ranges;
	if (tx.replaceSelection !== undefined) {
		for (const r of ranges) specs.push({ from: r.from, to: r.to, insert: tx.replaceSelection });
	}
	const changes = state.changes(specs);
	const wanted = tx.selections?.length ? tx.selections : tx.selection ? [tx.selection] : null;
	let selection: EditorSelection | undefined;
	if (wanted) {
		const next = changes.apply(doc);
		selection = EditorSelection.create(wanted.map((s) => EditorSelection.range(posToOffset(next, s.from), posToOffset(next, s.to ?? s.from))));
	} else if (tx.replaceSelection !== undefined) {
		selection = EditorSelection.create(
			ranges.map((r) => EditorSelection.cursor(changes.mapPos(r.to, 1))),
			state.selection.mainIndex,
		);
	}
	return { changes, selection, scrollIntoView: !!selection };
}

// The 0-based numbers of the lines the selections cover. A range that ends
// at the start of a line does not cover that line.
export function selectedLines(state: EditorState) {
	const lines = new Set<number>();
	for (const r of state.selection.ranges) {
		const first = state.doc.lineAt(r.from).number;
		const last = state.doc.lineAt(r.to).number;
		for (let n = first; n <= last; n++) {
			if (n === last && n > first && r.to === state.doc.line(n).from) break;
			lines.add(n - 1);
		}
	}
	return [...lines].sort((a, b) => a - b);
}

const EXEC: Record<EditorCommandName, (view: EditorView) => boolean> = {
	goUp: cmCommands.cursorLineUp,
	goDown: cmCommands.cursorLineDown,
	goLeft: cmCommands.cursorCharLeft,
	goRight: cmCommands.cursorCharRight,
	goStart: cmCommands.cursorDocStart,
	goEnd: cmCommands.cursorDocEnd,
	goWordLeft: cmCommands.cursorGroupLeft,
	goWordRight: cmCommands.cursorGroupRight,
	indentMore: cmCommands.indentMore,
	indentLess: cmCommands.indentLess,
	newlineAndIndent: cmCommands.insertNewlineAndIndent,
	swapLineUp: cmCommands.moveLineUp,
	swapLineDown: cmCommands.moveLineDown,
	deleteLine: cmCommands.deleteLine,
	toggleFold,
	foldAll,
	unfoldAll,
};

// Obsidian's Editor: a CodeMirror 5-style API over a CM6 view. Lines and
// columns are 0-based; every call is one CodeMirror transaction.
export class Editor {
	cm: EditorView;

	constructor(cm: EditorView) {
		this.cm = cm;
	}

	get #doc() {
		return this.cm.state.doc;
	}

	getDoc() {
		return this;
	}

	refresh() {
		this.cm.requestMeasure();
	}

	getValue() {
		return this.#doc.toString();
	}

	setValue(content: string) {
		this.cm.dispatch({ changes: { from: 0, to: this.#doc.length, insert: content } });
	}

	getLine(line: number) {
		if (line < 0 || line >= this.#doc.lines) return "";
		return this.#doc.line(line + 1).text;
	}

	setLine(n: number, text: string) {
		if (n < 0 || n >= this.#doc.lines) return;
		this.replaceRange(text, { line: n, ch: 0 }, { line: n, ch: Number.POSITIVE_INFINITY });
	}

	lineCount() {
		return this.#doc.lines;
	}

	lastLine() {
		return this.#doc.lines - 1;
	}

	getSelection() {
		const { from, to } = this.cm.state.selection.main;
		return this.cm.state.sliceDoc(from, to);
	}

	somethingSelected() {
		return this.cm.state.selection.ranges.some((r) => !r.empty);
	}

	getRange(from: EditorPosition, to: EditorPosition) {
		const a = this.posToOffset(from);
		const b = this.posToOffset(to);
		return this.cm.state.sliceDoc(Math.min(a, b), Math.max(a, b));
	}

	replaceSelection(replacement: string, origin?: string) {
		this.transaction({ replaceSelection: replacement }, origin);
	}

	replaceRange(replacement: string, from: EditorPosition, to?: EditorPosition, origin?: string) {
		const a = this.posToOffset(from);
		const b = to ? this.posToOffset(to) : a;
		this.cm.dispatch({
			changes: { from: Math.min(a, b), to: Math.max(a, b), insert: replacement },
			userEvent: origin,
		});
	}

	getCursor(which: "from" | "to" | "head" | "anchor" = "head"): EditorPosition {
		const r = this.cm.state.selection.main;
		const offset = which === "from" ? r.from : which === "to" ? r.to : which === "anchor" ? r.anchor : r.head;
		return this.offsetToPos(offset);
	}

	listSelections(): EditorSelectionRange[] {
		return this.cm.state.selection.ranges.map((r) => ({
			anchor: this.offsetToPos(r.anchor),
			head: this.offsetToPos(r.head),
		}));
	}

	setCursor(pos: EditorPosition | number, ch?: number) {
		const p = typeof pos === "number" ? { line: pos, ch: ch ?? 0 } : pos;
		this.cm.dispatch({ selection: { anchor: this.posToOffset(p) }, scrollIntoView: true });
	}

	setSelection(anchor: EditorPosition, head?: EditorPosition) {
		const a = this.posToOffset(anchor);
		this.cm.dispatch({ selection: { anchor: a, head: head ? this.posToOffset(head) : a }, scrollIntoView: true });
	}

	// Like CodeMirror 5, the main selection defaults to the current main
	// index, clamped to the new ranges.
	setSelections(ranges: EditorSelectionOrCaret[], main?: number) {
		if (ranges.length === 0) return;
		const index = Math.min(Math.max(main ?? this.cm.state.selection.mainIndex, 0), ranges.length - 1);
		const sel = EditorSelection.create(
			ranges.map((r) => EditorSelection.range(this.posToOffset(r.anchor), this.posToOffset(r.head ?? r.anchor))),
			index,
		);
		this.cm.dispatch({ selection: sel, scrollIntoView: true });
	}

	focus() {
		this.cm.focus();
	}

	blur() {
		this.cm.contentDOM.blur();
	}

	hasFocus() {
		return this.cm.hasFocus;
	}

	getScrollInfo() {
		const s = this.cm.scrollDOM;
		return { top: s.scrollTop, left: s.scrollLeft, width: s.scrollWidth, height: s.scrollHeight, clientHeight: s.clientHeight, clientWidth: s.clientWidth };
	}

	scrollTo(x?: number | null, y?: number | null) {
		if (x != null) this.cm.scrollDOM.scrollLeft = x;
		if (y != null) this.cm.scrollDOM.scrollTop = y;
	}

	scrollIntoView(range: EditorRange, center?: boolean) {
		const target = EditorSelection.range(this.posToOffset(range.from), this.posToOffset(range.to));
		this.cm.dispatch({ effects: EditorView.scrollIntoView(target, { y: center ? "center" : "nearest" }) });
	}

	undo() {
		cmCommands.undo(this.cm);
	}

	redo() {
		cmCommands.redo(this.cm);
	}

	exec(command: EditorCommandName) {
		EXEC[command]?.(this.cm);
	}

	transaction(tx: EditorTransaction, origin?: string) {
		const spec = transactionSpec(this.cm.state, tx);
		this.cm.dispatch(origin ? { ...spec, userEvent: origin } : spec);
	}

	wordAt(pos: EditorPosition): EditorRange | null {
		const range = this.cm.state.wordAt(this.posToOffset(pos));
		return range ? { from: this.offsetToPos(range.from), to: this.offsetToPos(range.to) } : null;
	}

	posToOffset(pos: EditorPosition) {
		return posToOffset(this.#doc, pos);
	}

	offsetToPos(offset: number) {
		return offsetToPos(this.#doc, offset);
	}

	processLines<T>(
		read: (line: number, lineText: string) => T | null,
		write: (line: number, lineText: string, value: T | null) => EditorChange | void,
		ignoreEmpty = false,
	) {
		let lines = selectedLines(this.cm.state);
		if (ignoreEmpty && lines.length > 1) lines = lines.filter((n) => this.getLine(n) !== "");
		const values = lines.map((n) => read(n, this.getLine(n)));
		const changes: EditorChange[] = [];
		lines.forEach((n, i) => {
			const change = write(n, this.getLine(n), values[i]);
			if (change) changes.push(change);
		});
		if (changes.length) this.transaction({ changes });
	}

	// Private Obsidian helpers some plugins call.
	getClickableTokenAt(pos: EditorPosition): { type: ClickableToken["type"]; text: string; start: EditorPosition; end: EditorPosition } | null {
		const token = clickableTokenAt(this.cm.state, this.posToOffset(pos));
		return token ? { type: token.type, text: token.text, start: this.offsetToPos(token.from), end: this.offsetToPos(token.to) } : null;
	}

	coordsAtPos(pos: EditorPosition, local = false) {
		const rect = this.cm.coordsAtPos(this.posToOffset(pos));
		if (!rect || !local) return rect;
		const box = this.cm.scrollDOM.getBoundingClientRect();
		const dx = box.left - this.cm.scrollDOM.scrollLeft;
		const dy = box.top - this.cm.scrollDOM.scrollTop;
		return { left: rect.left - dx, right: rect.right - dx, top: rect.top - dy, bottom: rect.bottom - dy };
	}

	posAtCoords(left: number, top: number): EditorPosition | null {
		const offset = this.cm.posAtCoords({ x: left, y: top }, false);
		return this.offsetToPos(offset);
	}

	posAtMouse(evt: MouseEvent): EditorPosition | null {
		return this.posAtCoords(evt.clientX, evt.clientY);
	}
}
