import { describe, expect, test } from "bun:test";
import { mergeText, textChanges } from "../src/api/view";

const apply = (text: string, changes: { from: number; to: number; insert: string }[]) => {
	let out = "";
	let pos = 0;
	for (const c of changes) {
		out += text.slice(pos, c.from) + c.insert;
		pos = c.to;
	}
	return out + text.slice(pos);
};

// A file changed on disk (a plugin capture, git, another editor) while the
// open view had unsaved edits: the view keeps both instead of dropping either.
describe("mergeText", () => {
	const base = "# Notes\n\nfirst line\nsecond line\n";

	test("keeps unsaved edits and a capture appended on disk", () => {
		const ours = "# Notes\n\nfirst line, edited\nsecond line\n";
		const theirs = "# Notes\n\nfirst line\nsecond line\n- captured\n";
		expect(mergeText(base, ours, theirs)).toEqual({ text: "# Notes\n\nfirst line, edited\nsecond line\n- captured\n", conflicts: 0 });
	});

	test("applies a deletion on disk next to an unrelated local edit", () => {
		const ours = "# Notes, renamed\n\nfirst line\nsecond line\n";
		const theirs = "# Notes\n\nsecond line\n";
		expect(mergeText(base, ours, theirs)).toEqual({ text: "# Notes, renamed\n\nsecond line\n", conflicts: 0 });
	});

	test("the same change on both sides lands once", () => {
		const both = "# Notes\n\nfirst line\nnew line\nsecond line\n";
		expect(mergeText(base, both, both)).toEqual({ text: both, conflicts: 0 });
	});

	test("a line changed differently on both sides keeps the file's version, then the local one", () => {
		const ours = "# Notes\n\nfirst line by me\nsecond line\n";
		const theirs = "# Notes\n\nfirst line by the plugin\nsecond line\n";
		expect(mergeText(base, ours, theirs)).toEqual({
			text: "# Notes\n\nfirst line by the plugin\nfirst line by me\nsecond line\n",
			conflicts: 1,
		});
	});

	test("text typed at the end and text appended on disk are both kept", () => {
		const ours = `${base}typed`;
		const theirs = `${base}appended`;
		expect(mergeText(base, ours, theirs)).toEqual({ text: `${base}appended\ntyped`, conflicts: 1 });
	});

	// A capture appended while the user types new lines at the end: no line
	// was changed twice, so no "appear twice" notice.
	test("two insertions at one place are both kept without a conflict", () => {
		const ours = `${base}typed line\n`;
		const theirs = `${base}- captured\n`;
		expect(mergeText(base, ours, theirs)).toEqual({ text: `${base}- captured\ntyped line\n`, conflicts: 0 });
	});

	test("edits on adjacent lines merge line by line", () => {
		const ours = "# Notes\n\nfirst line, edited\nsecond line\n";
		const theirs = "# Notes\n\nfirst line\nsecond line, edited outside\n";
		expect(mergeText(base, ours, theirs)).toEqual({ text: "# Notes\n\nfirst line, edited\nsecond line, edited outside\n", conflicts: 0 });
	});

	test("a note rewritten on both sides loses neither rewrite", () => {
		const lines = (tag: string) => Array.from({ length: 3000 }, (_, i) => `${tag} ${i}`).join("\n");
		const merged = mergeText(lines("base"), lines("mine"), lines("theirs"));
		expect(merged.text).toBe(`${lines("theirs")}\n${lines("mine")}`);
		expect(merged.conflicts).toBe(1);
	});
});

// An external reload is applied as these edits so the cursor and the undo
// history of the unchanged text survive.
describe("textChanges", () => {
	const cases: [string, string, string][] = [
		["edit inside a line", "alpha\nbeta\ngamma", "alpha\nbetter\ngamma"],
		["lines added at the end", "a\nb", "a\nb\nc\nd"],
		["trailing lines removed", "a\nb\nc", "a"],
		["changes at both ends", "x\nkeep\nkeep\ny", "x2\nkeep\nkeep\ny2"],
		["everything replaced", "one\ntwo", "three"],
		["from empty", "", "new\ntext"],
	];
	for (const [name, prev, next] of cases) {
		test(`${name}: applying the edits gives the new text`, () => {
			expect(apply(prev, textChanges(prev, next))).toBe(next);
		});
	}

	test("edits leave the text around them alone", () => {
		const prev = "head\nmiddle\ntail";
		const changes = textChanges(prev, "head\nmiddle!\ntail");
		expect(changes).toEqual([{ from: 11, to: 11, insert: "!" }]);
	});
});
