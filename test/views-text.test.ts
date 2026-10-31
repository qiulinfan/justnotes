import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installLanguageExtensions } from "../src/api/dom";
import { Vault } from "../src/api/vault";
import { mergeText, TextFileView, textChanges } from "../src/api/view";

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

	// QuickAdd captures under a heading while the heading line has unsaved
	// edits: the heading must not appear twice.
	test("lines added on disk next to a line edited locally merge without a conflict", () => {
		const ours = "# Notes, renamed\n\nfirst line\nsecond line\n";
		const theirs = "# Notes\n- captured\n\nfirst line\nsecond line\n";
		expect(mergeText(base, ours, theirs)).toEqual({ text: "# Notes, renamed\n- captured\n\nfirst line\nsecond line\n", conflicts: 0 });
	});

	test("lines added locally next to a line changed on disk merge without a conflict", () => {
		const ours = "# Notes\n\nfirst line\ntyped line\nsecond line\n";
		const theirs = "# Notes\n\nfirst line, edited outside\nsecond line\n";
		expect(mergeText(base, ours, theirs)).toEqual({ text: "# Notes\n\nfirst line, edited outside\ntyped line\nsecond line\n", conflicts: 0 });
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

// A plugin writes the note (a capture, processFrontMatter) while the open view
// saves its unsaved edits: the file keeps both, and a note deleted meanwhile
// does not come back.
describe("TextFileView saves", () => {
	// Saving never touches a view's DOM, so its elements are inert stand-ins.
	const inert: any = new Proxy(() => inert, { get: (_target, key) => (key === "then" ? undefined : key === "contains" ? () => false : inert) });
	const globals = globalThis as { createDiv?: unknown; document?: unknown };
	beforeAll(() => {
		installLanguageExtensions();
		globals.createDiv = () => inert;
		globals.document = inert;
	});
	afterAll(() => {
		delete globals.createDiv;
		delete globals.document;
	});

	class NoteView extends TextFileView {
		text = "";
		getViewType() {
			return "note";
		}
		getViewData() {
			return this.text;
		}
		setViewData(data: string) {
			this.text = data;
		}
		clear() {
			this.text = "";
		}
	}

	const open: { vault: Vault; view: NoteView; dir: string }[] = [];
	afterEach(() => {
		for (const { vault, view, dir } of open.splice(0)) {
			view.unload();
			vault.close();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	// The note open in a view with " edit" typed on its first line.
	async function editedNote(text: string) {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-view-")));
		fs.writeFileSync(path.join(dir, "n.md"), text);
		const vault = new Vault(dir);
		await vault.load();
		const view = new NoteView({ app: { vault }, updateHeader() {} } as any);
		open.push({ vault, view, dir });
		view.load();
		const file = vault.getFileByPath("n.md")!;
		await view.loadFile(file);
		view.text = text.replace("\n", " edit\n");
		view.requestSave();
		return { vault, view, file, full: path.join(dir, "n.md") };
	}

	test("a plugin's write that lands while the view saves is merged, not overwritten", async () => {
		const { vault, view, file, full } = await editedNote("line1\nline2\nline3\n");
		await Promise.all([view.save(), vault.modify(file, "line1\nline2\nline3 plugin\n")]);
		expect(fs.readFileSync(full, "utf8")).toBe("line1 edit\nline2\nline3 plugin\n");
		expect(view.text).toBe("line1 edit\nline2\nline3 plugin\n");
		expect(view.dirty).toBe(false);
	});

	// QuickAdd's capture reads the note, the view saves its edit, and the
	// capture then writes text built on what it read: the edit stays. A
	// capture adds lines, and may write into a blank line below its target.
	const captures: [string, string, string, string][] = [
		["appended", "line1\nline2\nline3\n", "line1\nline2\nline3\n- captured\n", "line1 edit\nline2\nline3\n- captured\n"],
		["written into a blank line", "line1\n\nline3\n", "line1\n- captured\nline3\n", "line1 edit\n- captured\nline3\n"],
	];
	for (const [name, note, captured, merged] of captures) {
		test(`a plugin's write built on the text from before the view's save (a capture ${name}) keeps the saved edit`, async () => {
			const { vault, view, file, full } = await editedNote(note);
			await view.save();
			await vault.modify(file, captured);
			// Saving again waits for the view to take the change in.
			await view.save();
			expect(fs.readFileSync(full, "utf8")).toBe(merged);
			expect(view.text).toBe(merged);
		});
	}

	// After a save that only removed lines, a capture holds every line of the
	// saved text, as a write built on it does: the removal stays.
	test("a capture built on the text from before a save that removed a line keeps the line removed", async () => {
		const { vault, view, file, full } = await editedNote("line1\nline2\nline3\n");
		view.text = "line1\nline3\n";
		view.requestSave();
		await view.save();
		await vault.modify(file, "line1\nline2\nline3\n- captured\n");
		await view.save();
		expect(fs.readFileSync(full, "utf8")).toBe("line1\nline3\n- captured\n");
		expect(view.text).toBe("line1\nline3\n- captured\n");
	});

	const afterSave: [string, string][] = [
		["a write built on the saved text", "line1 edit\nline2\nline3\n- captured\n"],
		["a plugin rewriting the saved line", "line1 rewritten\nline2\nline3\n"],
		["an outside revert to the text before the save", "line1\nline2\nline3\n"],
		["an outside revert to the text before the save, with a line removed", "line1\nline2\n"],
	];
	for (const [name, text] of afterSave) {
		test(`${name} right after the view's save is taken as written`, async () => {
			const { vault, view, file, full } = await editedNote("line1\nline2\nline3\n");
			await view.save();
			await vault.modify(file, text);
			await view.save();
			expect(fs.readFileSync(full, "utf8")).toBe(text);
			expect(view.text).toBe(text);
		});
	}

	// A write made from the saved text has the save's edits already, also when
	// it fills a blank line next to the lines the save added (QuickAdd writes
	// into the blank line below its target, or onto the empty last line).
	const builtOnSave: [string, string, string, string][] = [
		["onto the empty last line below the saved line", "# Log\n- first\n", "# Log\n- first\n- typed\n", "# Log\n- first\n- typed\n- cap"],
		["into the blank line above the saved line", "## Inbox\n\n- old\n", "## Inbox\n\n- new\n- old\n", "## Inbox\n- cap\n- new\n- old\n"],
		["below a line typed onto the empty last line", "## B\n", "## B\n- t1", "## B\n- t1\n- cap\n"],
	];
	for (const [name, note, saved, written] of builtOnSave) {
		test(`a write built on the saved text that adds a line ${name} is taken as written`, async () => {
			const { vault, view, file, full } = await editedNote(note);
			view.text = saved;
			view.requestSave();
			await view.save();
			await vault.modify(file, written);
			await view.save();
			expect(fs.readFileSync(full, "utf8")).toBe(written);
			expect(view.text).toBe(written);
		});
	}

	// git discarding the note's changes, or a plugin restoring a version, right
	// after the last of several saves. When the saves since that version only
	// removed lines, it is the text the last save replaced with lines added, as
	// a capture is.
	const reverts: [string, string[], string][] = [
		["the opened text, after two saves", ["line1 edit\nline2\nline3\n", "line1 edit\nline2\nline3 edit\n"], "line1\nline2\nline3\n"],
		["the opened text, after a save that removed a line", ["line1\nline3\n", "line1\nline3 edit\n"], "line1\nline2\nline3\n"],
		["a saved version, after a save that removed a line", ["line1\nline2\nline3\nline4\n", "line1\nline3\nline4\n", "line1\nline3\nline4 edit\n"], "line1\nline2\nline3\nline4\n"],
	];
	for (const [name, saves, restored] of reverts) {
		test(`an outside revert to ${name} is taken as written`, async () => {
			const { vault, view, file, full } = await editedNote("line1\nline2\nline3\n");
			for (const text of saves) {
				view.text = text;
				view.requestSave();
				await view.save();
			}
			await vault.modify(file, restored);
			await view.save();
			expect(fs.readFileSync(full, "utf8")).toBe(restored);
			expect(view.text).toBe(restored);
		});
	}

	test("a save racing an outside delete keeps the edits unsaved and does not re-create the file", async () => {
		const { view, full } = await editedNote("line1\nline2\n");
		fs.rmSync(full);
		await view.save();
		expect(fs.existsSync(full)).toBe(false);
		expect(view.dirty).toBe(true);
	});
});
