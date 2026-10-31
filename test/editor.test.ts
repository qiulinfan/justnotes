import { describe, expect, test } from "bun:test";
import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { offsetToPos, posToOffset, selectedLines, transactionSpec } from "../src/api/editor";

const doc = Text.of(["alpha", "beta", "gamma"]);

function apply(state: EditorState, spec: ReturnType<typeof transactionSpec>) {
	const next = state.update(spec).state;
	return { text: next.doc.toString(), ranges: next.selection.ranges.map((r) => [r.anchor, r.head]) };
}

// Editor positions are clipped like CodeMirror 5's clipPos; plugins rely on
// `{ line: lineCount(), ch: 0 }` meaning "the end of the note".
describe("posToOffset", () => {
	test("a line past the last one is the end of the document", () => {
		expect(posToOffset(doc, { line: doc.lines, ch: 0 })).toBe(doc.length);
	});

	test("a line before the first is the start, whatever the column", () => {
		expect(posToOffset(doc, { line: -1, ch: 5 })).toBe(0);
	});

	test("a column past the line end stays on that line", () => {
		expect(posToOffset(doc, { line: 1, ch: 99 })).toBe(doc.line(2).to);
	});
});

describe("offsetToPos", () => {
	test("offsets outside the document clamp to its ends", () => {
		expect(offsetToPos(doc, -4)).toEqual({ line: 0, ch: 0 });
		expect(offsetToPos(doc, 999)).toEqual({ line: 2, ch: 5 });
	});
});

// Editor.transaction is one CodeMirror transaction: one undo step and one
// editor-change event.
describe("transactionSpec", () => {
	test("changes and replaceSelection are both positioned in the current document", () => {
		const state = EditorState.create({ doc: "alpha\nbeta", selection: { anchor: 2 } });
		const result = apply(state, transactionSpec(state, { replaceSelection: "Z", changes: [{ from: { line: 1, ch: 0 }, to: { line: 1, ch: 4 }, text: "BETA" }] }));
		expect(result.text).toBe("alZpha\nBETA");
		expect(result.ranges).toEqual([[3, 3]]);
	});

	test("the new selection is read in the document the changes produce", () => {
		const state = EditorState.create({ doc: "alpha\nbeta" });
		const result = apply(state, transactionSpec(state, { changes: [{ from: { line: 0, ch: 0 }, text: "top\n" }], selection: { from: { line: 1, ch: 5 } } }));
		expect(result.text).toBe("top\nalpha\nbeta");
		expect(result.ranges).toEqual([[9, 9]]);
	});

	test("replaceSelection replaces every range and leaves a cursor after each", () => {
		const state = EditorState.create({
			doc: "one two",
			selection: EditorSelection.create([EditorSelection.range(0, 3), EditorSelection.cursor(7)]),
			extensions: EditorState.allowMultipleSelections.of(true),
		});
		const result = apply(state, transactionSpec(state, { replaceSelection: "X" }));
		expect(result.text).toBe("X twoX");
		expect(result.ranges).toEqual([
			[1, 1],
			[6, 6],
		]);
	});
});

describe("selectedLines", () => {
	test("covers each line once, and not a line the selection only reaches the start of", () => {
		const state = EditorState.create({
			doc: "a\nb\nc\nd",
			selection: EditorSelection.create([EditorSelection.range(0, 4), EditorSelection.cursor(3)]),
			extensions: EditorState.allowMultipleSelections.of(true),
		});
		expect(selectedLines(state)).toEqual([0, 1]);
	});
});
