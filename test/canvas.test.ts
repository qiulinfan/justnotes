import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installLanguageExtensions } from "../src/api/dom";
import { Vault } from "../src/api/vault";
import { mergeWith, TextFileView } from "../src/api/view";
import { facingSides, mergeCanvas, nearestSide, parseCanvas, parseColor, renameInCanvas, stringifyCanvas } from "../src/renderer/canvas-data";

const text = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "text", text: id, x: 0, y: 0, width: 250, height: 60, ...extra });
const file = (nodes: object[], edges: object[] = [], extra: Record<string, unknown> = {}) => stringifyCanvas({ nodes, edges, ...extra } as any);

// The canvas view writes what Obsidian writes and reads what plugins write.
describe("canvas files", () => {
	// QuickAdd writes a canvas with JSON.stringify(data, null, "\t"); saving it
	// again gives Obsidian's layout, every field kept.
	test("a saved canvas has one node or edge per line, unknown fields kept in place", () => {
		const data = {
			nodes: [{ id: "a", type: "text", text: "A", x: 0, y: 0, width: 1, height: 1, custom: { keep: 1 } }, text("b")],
			edges: [{ id: "e", fromNode: "a", toNode: "b", weight: 2 }],
			metadata: { version: "1.0" },
		};
		const written = stringifyCanvas(parseCanvas(JSON.stringify(data, null, "\t")));
		expect(written).toBe(
			[
				"{",
				'\t"nodes":[',
				'\t\t{"id":"a","type":"text","text":"A","x":0,"y":0,"width":1,"height":1,"custom":{"keep":1}},',
				'\t\t{"id":"b","type":"text","text":"b","x":0,"y":0,"width":250,"height":60}',
				"\t],",
				'\t"edges":[',
				'\t\t{"id":"e","fromNode":"a","toNode":"b","weight":2}',
				"\t],",
				'\t"metadata":{"version":"1.0"}',
				"}",
			].join("\n"),
		);
	});

	test("an empty file is an empty canvas; other text that is no canvas throws", () => {
		expect(parseCanvas("")).toEqual({ nodes: [], edges: [] });
		expect(() => parseCanvas("not json")).toThrow();
		expect(() => parseCanvas("[1, 2]")).toThrow();
	});

	// A line merge (git) of two versions that each added a node leaves the
	// commas out of place; the one-item-per-line layout still reads.
	test("Obsidian's layout with commas out of place reads item by item", () => {
		const broken = ["{", '\t"nodes":[', `\t\t${JSON.stringify(text("a"))},`, `\t\t${JSON.stringify(text("b"))}`, `\t\t${JSON.stringify(text("c"))}`, "\t],", '\t"edges":[]', "}"].join("\n");
		expect(parseCanvas(broken).nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
	});

	test("an edge to a node the file lacks is dropped", () => {
		expect(parseCanvas(file([text("a")], [{ id: "e", fromNode: "a", toNode: "gone" }])).edges).toEqual([]);
	});

	test("colors: 1 to 6 are presets, hex is custom, anything else none", () => {
		expect(parseColor("3")).toEqual({ preset: "3" });
		expect(parseColor("#ff8800")).toEqual({ rgb: "255, 136, 0" });
		expect(parseColor("#f80")).toEqual({ rgb: "255, 136, 0" });
		expect(parseColor("7")).toBeNull();
	});
});

// Unsaved canvas edits meet a change on disk (QuickAdd's capture to a
// configured card, git): merged by node and edge id, never into broken JSON.
describe("mergeCanvas", () => {
	const base = file([text("a"), text("b")], [{ id: "e", fromNode: "a", toNode: "b" }]);
	const nodes = (merged: string) => Object.fromEntries(parseCanvas(merged).nodes.map((n) => [n.id, n]));

	test("different fields of one node changed on each side are both kept", () => {
		const ours = file([text("a", { x: 100 }), text("b")], [{ id: "e", fromNode: "a", toNode: "b" }]);
		const theirs = JSON.stringify({ nodes: [text("a", { text: "a\n- captured" }), text("b")], edges: [{ id: "e", fromNode: "a", toNode: "b" }] }, null, "\t");
		const merged = mergeCanvas(base, ours, theirs);
		expect(merged.conflicts).toBe(0);
		expect(nodes(merged.text).a).toMatchObject({ x: 100, text: "a\n- captured" });
	});

	test("nodes added on either side are all kept", () => {
		const ours = file([text("a"), text("b"), text("mine")], [{ id: "e", fromNode: "a", toNode: "b" }]);
		const theirs = file([text("a"), text("b"), text("theirs")], [{ id: "e", fromNode: "a", toNode: "b" }]);
		expect(Object.keys(nodes(mergeCanvas(base, ours, theirs).text))).toEqual(["a", "b", "theirs", "mine"]);
	});

	test("a node removed on disk goes, with its edges, unless it was changed here", () => {
		const theirs = file([text("a")]);
		expect(parseCanvas(mergeCanvas(base, base, theirs).text)).toMatchObject({ nodes: [{ id: "a" }], edges: [] });
		const ours = file([text("a"), text("b", { color: "2" })], [{ id: "e", fromNode: "a", toNode: "b" }]);
		expect(Object.keys(nodes(mergeCanvas(base, ours, theirs).text))).toEqual(["a", "b"]);
	});

	test("one field changed differently on both sides takes the file's value as a conflict", () => {
		const merged = mergeCanvas(base, file([text("a", { text: "mine" }), text("b")]), file([text("a", { text: "theirs" }), text("b")]));
		expect(merged.conflicts).toBe(1);
		expect(nodes(merged.text).a.text).toBe("theirs");
	});

	test("a file on disk that is no canvas loses to the view's edits", () => {
		const ours = file([text("a", { x: 5 }), text("b")]);
		expect(mergeCanvas(base, ours, "{ broken")).toEqual({ text: ours, conflicts: 1 });
	});
});

// The open canvas view registers mergeCanvas with its TextFileView: a
// plugin's write to the canvas file while the view has unsaved edits keeps
// both, as valid JSON.
describe("a text file view with the canvas merge", () => {
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

	class DataView extends TextFileView {
		text = "";
		getViewType() {
			return "canvas";
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

	let dir = "";
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	test("a capture written over unsaved edits is merged by card", async () => {
		dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-canvas-")));
		const full = path.join(dir, "b.canvas");
		fs.writeFileSync(full, file([text("a"), text("b")]));
		const vault = new Vault(dir);
		await vault.load();
		const view = new DataView({ app: { vault }, updateHeader() {} } as any);
		mergeWith(view, { merge: mergeCanvas, conflictNotice: () => "" });
		view.load();
		const canvas = vault.getFileByPath("b.canvas")!;
		await view.loadFile(canvas);
		view.text = file([text("a", { x: 300 }), text("b")]);
		view.requestSave();
		await vault.modify(canvas, JSON.stringify({ nodes: [text("a"), text("b", { text: "b\n- captured" })], edges: [] }, null, "\t"));
		await view.save();
		const saved = parseCanvas(fs.readFileSync(full, "utf8"));
		expect(saved.nodes).toMatchObject([
			{ id: "a", x: 300 },
			{ id: "b", text: "b\n- captured" },
		]);
		view.unload();
		vault.close();
	});
});

describe("renaming files a canvas shows", () => {
	const canvas = file([
		{ id: "f", type: "file", file: "Notes/A.md", x: 0, y: 0, width: 1, height: 1 },
		{ id: "g", type: "group", background: "Notes/img.png", x: 0, y: 0, width: 1, height: 1 },
		{ id: "o", type: "file", file: "Notes2/A.md", x: 0, y: 0, width: 1, height: 1 },
	]);
	const paths = (out: string | null) => parseCanvas(out!).nodes.map((n) => n.file ?? n.background);

	test("a renamed file moves its card", () => {
		expect(paths(renameInCanvas(canvas, "Notes/A.md", "B.md"))).toEqual(["B.md", "Notes/img.png", "Notes2/A.md"]);
	});

	test("a renamed folder moves every card inside it, and only those", () => {
		expect(paths(renameInCanvas(canvas, "Notes", "Archive/Notes"))).toEqual(["Archive/Notes/A.md", "Archive/Notes/img.png", "Notes2/A.md"]);
	});

	test("a canvas that shows none of it is left alone", () => {
		expect(renameInCanvas(canvas, "Other.md", "X.md")).toBeNull();
	});
});

describe("edge sides", () => {
	const box = { x: 0, y: 0, width: 100, height: 50 };

	test("an edge without sides joins the facing sides along the axis the nodes are farther apart on", () => {
		expect(facingSides(box, { ...box, x: 300, y: 40 })).toEqual(["right", "left"]);
		expect(facingSides(box, { ...box, x: 20, y: -300 })).toEqual(["top", "bottom"]);
	});

	test("an edge dropped on a node attaches to the side nearest the pointer", () => {
		expect(nearestSide(box, { x: 95, y: 30 })).toBe("right");
		expect(nearestSide(box, { x: 50, y: 48 })).toBe("bottom");
	});
});
