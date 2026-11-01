import { syntaxTree } from "@codemirror/language";
import { Annotation, EditorSelection, EditorState, type Extension, Prec, RangeSet, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType } from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { editorLivePreviewField } from "./live-preview";

// Fenced code in Live Preview, as Typora shows it: the fence lines stay
// hidden while the cursor is inside the block, the language is edited in a
// field at the box's bottom right, and the source shows only while one
// selection covers the whole block. Edits typed or deleted while the fences
// are hidden may not break them: such a transaction is dropped.

export interface Fence {
	open: { from: number; to: number };
	close: { from: number; to: number };
	// Where the info string starts: right after the opening backticks.
	infoFrom: number;
}

// The fence lines of a closed block with at least one line of code that has
// its lines to itself (not in a quote, nothing before it on its line).
export function closedFence(state: EditorState, node: SyntaxNode): Fence | null {
	const doc = state.doc;
	const marks = node.getChildren("CodeMark");
	const first = doc.lineAt(node.from);
	const last = doc.lineAt(node.to);
	if (marks.length < 2 || last.number - first.number < 2) return null;
	if (doc.sliceString(first.from, node.from).trim()) return null;
	for (let p = node.parent; p; p = p.parent) if (p.name === "Blockquote") return null;
	return { open: { from: first.from, to: first.to }, close: { from: last.from, to: last.to }, infoFrom: marks[0].to };
}

export function coversFence(state: EditorState, f: Fence) {
	return state.selection.ranges.some((r) => r.from <= f.open.from && r.to >= f.close.to);
}

// Fenced code sits at the top level or in lists; nothing else holds one this
// treatment applies to, so the walk enters only those.
const CONTAINERS = new Set(["Document", "BulletList", "OrderedList", "ListItem"]);
const allFences = new WeakMap<Tree, Fence[]>();

function fencesOf(state: EditorState): Fence[] {
	const tree = syntaxTree(state);
	let list = allFences.get(tree);
	if (list) return list;
	list = [];
	tree.iterate({
		enter: (ref) => {
			if (ref.name === "FencedCode") {
				const f = closedFence(state, ref.node);
				if (f) list!.push(f);
			}
			return CONTAINERS.has(ref.name);
		},
	});
	allFences.set(tree, list);
	return list;
}

export function hiddenFences(state: EditorState): Fence[] {
	if (state.field(editorLivePreviewField, false) === false) return [];
	return fencesOf(state).filter((f) => !coversFence(state, f));
}

// The stretches a hidden fence line spans with the line breaks on both sides:
// the cursor moves over them in one step.
function guards(f: Fence, length: number): [number, number][] {
	return [
		[Math.max(0, f.open.from - 1), f.open.to + 1],
		[f.close.from - 1, Math.min(length, f.close.to + 1)],
	];
}

const fenceEdit = Annotation.define<boolean>();

// Whether both fence lines survive the change as whole lines with their text,
// with a line of code between them.
function intact(tr: Transaction, f: Fence) {
	const before = tr.startState.doc;
	const after = tr.newDoc;
	const line = (from: number, to: number) => {
		const text = before.sliceString(from, to);
		const at = tr.changes.mapPos(from, 1);
		const l = after.lineAt(at);
		return l.from === at && l.text === text ? l.number : null;
	};
	const open = line(f.open.from, f.open.to);
	const close = line(f.close.from, f.close.to);
	return open !== null && close !== null && close - open >= 2;
}

const protectFences = EditorState.transactionFilter.of((tr) => {
	if (!tr.docChanged || tr.annotation(fenceEdit) || !["input", "delete", "move"].some((e) => tr.isUserEvent(e))) return tr;
	const length = tr.startState.doc.length;
	for (const f of hiddenFences(tr.startState)) {
		if (!guards(f, length).some(([from, to]) => tr.changes.touchesRange(from, to))) continue;
		if (!intact(tr, f)) return [];
	}
	return tr;
});

// A cursor that lands on a hidden fence line (a click on the box's edge, the
// start or end of the note) moves into the code next to it.
const keepCursorInCode = EditorState.transactionFilter.of((tr) => {
	if (!tr.selection && !tr.docChanged) return tr;
	const fences = hiddenFences(tr.state);
	if (!fences.length) return tr;
	let moved = false;
	const ranges = tr.state.selection.ranges.map((r) => {
		if (!r.empty) return r;
		for (const f of fences) {
			const to = r.head >= f.open.from && r.head <= f.open.to ? f.open.to + 1 : r.head >= f.close.from && r.head <= f.close.to ? f.close.from - 1 : null;
			if (to !== null) {
				moved = true;
				return EditorSelection.cursor(to);
			}
		}
		return r;
	});
	if (!moved) return tr;
	return [tr, { selection: EditorSelection.create(ranges, tr.state.selection.mainIndex), sequential: true }];
});

const atomicFences = EditorView.atomicRanges.of((view) => {
	const length = view.state.doc.length;
	const ranges = hiddenFences(view.state).flatMap((f) => guards(f, length).map(([from, to]) => skip.range(from, to)));
	return RangeSet.of(ranges, true);
});
const skip = Decoration.mark({});

function fenceAt(state: EditorState, test: (f: Fence) => boolean) {
	return hiddenFences(state).find(test);
}

// Backspace at the start of an empty block removes it; at the start of the
// line under a block it removes that line when it is empty, else it only
// moves into the code. Anywhere else next to a hidden fence it does nothing
// (protectFences drops the edit).
function backspace(view: EditorView) {
	const { state } = view;
	const sel = state.selection.main;
	if (!sel.empty || state.selection.ranges.length > 1) return false;
	const pos = sel.head;
	const emptied = fenceAt(state, (f) => pos === f.open.to + 1 && f.close.from - 1 === pos);
	if (emptied) {
		view.dispatch({ changes: { from: emptied.open.from, to: emptied.close.to }, selection: { anchor: emptied.open.from }, annotations: fenceEdit.of(true), userEvent: "delete.backward", scrollIntoView: true });
		return true;
	}
	const above = fenceAt(state, (f) => pos === f.close.to + 1);
	if (above) {
		const line = state.doc.lineAt(pos);
		const changes = line.length === 0 ? { from: above.close.to, to: pos } : undefined;
		view.dispatch({ changes, selection: { anchor: above.close.from - 1 }, annotations: fenceEdit.of(true), userEvent: "delete.backward", scrollIntoView: true });
		return true;
	}
	return false;
}

// Up from the first line of a block at the very start of the note, or down
// from the last line of one at its very end, adds an empty line there to
// go to, as Typora does.
function leave(forward: boolean) {
	return (view: EditorView) => {
		const { state } = view;
		const sel = state.selection.main;
		if (!sel.empty || state.selection.ranges.length > 1) return false;
		const target = view.moveVertically(sel, forward).head;
		const inCode = (f: Fence) => sel.head > f.open.to && sel.head < f.close.from;
		const f = fenceAt(state, (f) => inCode(f) && (forward ? f.close.to === state.doc.length && target >= f.close.from : f.open.from === 0 && target <= f.open.to));
		if (!f) return false;
		const at = forward ? state.doc.length : 0;
		view.dispatch({ changes: { from: at, insert: "\n" }, selection: { anchor: forward ? at + 1 : 0 }, annotations: fenceEdit.of(true), userEvent: "input", scrollIntoView: true });
		return true;
	};
}

// The opening fence line: the top edge of the box.
export class FenceTopWidget extends WidgetType {
	eq() {
		return true;
	}

	toDOM() {
		return createDiv("cm-codeblock-header");
	}
}

// The closing fence line: the bottom edge of the box with the info string
// (the language) in a field at its right. A change applies on Enter or when
// the field loses focus; Escape puts the field back.
export class FenceLanguageWidget extends WidgetType {
	constructor(readonly info: string) {
		super();
	}

	eq(other: FenceLanguageWidget) {
		return other.info === this.info;
	}

	toDOM(view: EditorView) {
		const el = createDiv("cm-codeblock-footer");
		const input = el.createEl("input", { cls: "code-block-language", type: "text", value: this.info, attr: { placeholder: "language", spellcheck: "false", "aria-label": "Code block language" } });
		input.addEventListener("change", () => this.#apply(view, el, input.value));
		input.addEventListener("keydown", (evt) => {
			if (evt.isComposing) return;
			if (evt.key === "Enter" || evt.key === "Escape") {
				evt.preventDefault();
				if (evt.key === "Escape") input.value = input.defaultValue;
				else this.#apply(view, el, input.value);
				const f = this.#fence(view, el);
				view.focus();
				if (f) view.dispatch({ selection: { anchor: f.close.from - 1 } });
			}
		});
		return el;
	}

	updateDOM(dom: HTMLElement) {
		const input = dom.querySelector("input");
		if (!input) return false;
		input.defaultValue = this.info;
		if (input.ownerDocument.activeElement !== input) input.value = this.info;
		return true;
	}

	#fence(view: EditorView, el: HTMLElement) {
		if (!el.isConnected) return undefined;
		const pos = view.posAtDOM(el);
		return fencesOf(view.state).find((f) => pos >= f.close.from && pos <= f.close.to);
	}

	#apply(view: EditorView, el: HTMLElement, value: string) {
		const f = this.#fence(view, el);
		// A backtick fence's info string can hold no backtick.
		const info = value.replace(/`/g, "").trim();
		if (!f || view.state.sliceDoc(f.infoFrom, f.open.to) === info) return;
		view.dispatch({ changes: { from: f.infoFrom, to: f.open.to, insert: info }, annotations: fenceEdit.of(true) });
	}
}

export function codeFences(): Extension {
	return [
		protectFences,
		keepCursorInCode,
		atomicFences,
		Prec.highest(
			keymap.of([
				{ key: "Backspace", run: backspace },
				{ key: "ArrowDown", run: leave(true) },
				{ key: "ArrowUp", run: leave(false) },
			]),
		),
	];
}
