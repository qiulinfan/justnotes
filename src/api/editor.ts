import * as cmCommands from "@codemirror/commands";
import { foldAll, foldCode, unfoldAll } from "@codemirror/language";
import { EditorSelection, StateEffect, StateField, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface EditorPosition {
	line: number;
	ch: number;
}

export interface EditorRange {
	from: EditorPosition;
	to: EditorPosition;
}

export interface EditorSelectionRange {
	anchor: EditorPosition;
	head: EditorPosition;
}

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
export const editorLivePreviewField = StateField.define<boolean>({
	create: () => true,
	update: (v) => v,
});

export function bindEditorFields(view: EditorView, info: any) {
	view.dispatch({ effects: [setView.of(view), setInfo.of(info)] });
}

export function posToOffset(doc: Text, pos: EditorPosition) {
	const line = doc.line(Math.min(Math.max(pos.line, 0), doc.lines - 1) + 1);
	return Math.min(line.from + Math.max(pos.ch, 0), line.to);
}

export function offsetToPos(doc: Text, offset: number): EditorPosition {
	const line = doc.lineAt(Math.min(Math.max(offset, 0), doc.length));
	return { line: line.number - 1, ch: offset - line.from };
}

const EXEC: Record<string, (view: EditorView) => boolean> = {
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
	toggleFold: foldCode,
	foldAll,
	unfoldAll,
};

// Obsidian's Editor: a CodeMirror 5-style API over a CM6 view. Lines and
// columns are 0-based.
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
		const line = this.#doc.line(n + 1);
		this.cm.dispatch({ changes: { from: line.from, to: line.to, insert: text } });
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
		this.cm.dispatch(this.cm.state.replaceSelection(replacement), { userEvent: origin });
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

	setSelections(ranges: EditorSelectionRange[], main?: number) {
		if (ranges.length === 0) return;
		const sel = EditorSelection.create(
			ranges.map((r) => EditorSelection.range(this.posToOffset(r.anchor), this.posToOffset(r.head ?? r.anchor))),
			main ?? 0,
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
		return { top: s.scrollTop, left: s.scrollLeft, width: s.clientWidth, height: s.clientHeight, clientHeight: s.clientHeight, clientWidth: s.clientWidth };
	}

	scrollTo(x?: number | null, y?: number | null) {
		if (x != null) this.cm.scrollDOM.scrollLeft = x;
		if (y != null) this.cm.scrollDOM.scrollTop = y;
	}

	scrollIntoView(range: EditorRange, center?: boolean) {
		this.cm.dispatch({
			effects: EditorView.scrollIntoView(this.posToOffset(range.from), { y: center ? "center" : "nearest" }),
		});
	}

	undo() {
		cmCommands.undo(this.cm);
	}

	redo() {
		cmCommands.redo(this.cm);
	}

	exec(command: string) {
		EXEC[command]?.(this.cm);
	}

	transaction(tx: any, origin?: string) {
		const spec: any = { userEvent: origin };
		if (tx.changes) {
			spec.changes = tx.changes.map((c: any) => ({
				from: this.posToOffset(c.from),
				to: c.to ? this.posToOffset(c.to) : undefined,
				insert: c.text,
			}));
		}
		if (tx.replaceSelection !== undefined) {
			this.cm.dispatch({ ...this.cm.state.replaceSelection(tx.replaceSelection), userEvent: spec.userEvent });
		}
		const sels = tx.selections ?? (tx.selection ? [tx.selection] : null);
		if (sels) {
			spec.selection = EditorSelection.create(
				sels.map((s: any) => EditorSelection.range(this.posToOffset(s.from), this.posToOffset(s.to ?? s.from))),
			);
		}
		if (spec.changes || spec.selection) this.cm.dispatch(spec);
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

	processLines<T>(read: (line: number, lineText: string) => T | null, write: (line: number, lineText: string, value: T | null) => any, ignoreEmpty = false) {
		const changes: any[] = [];
		for (let i = 0; i < this.#doc.lines; i++) {
			const line = this.#doc.line(i + 1);
			if (ignoreEmpty && !line.text) continue;
			const value = read(i, line.text);
			const change = write(i, line.text, value);
			if (change) {
				changes.push({ from: this.posToOffset(change.from), to: change.to ? this.posToOffset(change.to) : undefined, insert: change.text });
			}
		}
		if (changes.length) this.cm.dispatch({ changes });
	}
}
