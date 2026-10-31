import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installLanguageExtensions } from "../src/api/dom";
import { Vault } from "../src/api/vault";
import { mergeWith, TextFileView } from "../src/api/view";
import { dropLayout, facingSides, fitSize, mergeCanvas, nearestSide, parseCanvas, parseColor, readViewport, renameInCanvas, snapEdge, snapMove, stringifyCanvas } from "../src/renderer/canvas-data";

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

// Files dropped together onto a canvas: cards that overlap or land far from
// the pointer are what the user would see go wrong.
describe("dropped cards", () => {
	const card = { width: 400, height: 400 };

	test("a few cards sit side by side in a row centred on the drop point", () => {
		expect(dropLayout({ x: 0, y: 0 }, [card, card, card], 20)).toEqual([
			{ x: -620, y: -200, width: 400, height: 400 },
			{ x: -200, y: -200, width: 400, height: 400 },
			{ x: 220, y: -200, width: 400, height: 400 },
		]);
	});

	test("more than four wrap into a grid whose cells fit each column's widest and each row's tallest card", () => {
		const sizes = [card, { width: 400, height: 225 }, { width: 200, height: 400 }, card, { width: 400, height: 100 }];
		const rects = dropLayout({ x: 0, y: 0 }, sizes, 20);
		// Three columns (400, 400, 200 wide), two rows (400, 400 tall).
		expect(rects.map((r) => [r.x, r.y])).toEqual([
			[-520, -410],
			[-100, -410],
			[320, -410],
			[-520, 10],
			[-100, 10],
		]);
	});

	test("media cards keep their aspect ratio inside the default card; an unknown size takes the whole card", () => {
		expect(fitSize({ width: 1920, height: 1080 }, card)).toEqual({ width: 400, height: 225 });
		expect(fitSize({ width: 1000, height: 2000 }, card)).toEqual({ width: 200, height: 400 });
		expect(fitSize(null, card)).toEqual(card);
	});
});

// A canvas leaf restores its pan and zoom from the layout's viewState; a
// malformed one must fall back to fitting rather than put the view at NaN.
describe("readViewport", () => {
	test("finite numbers are taken, the zoom clamped to the canvas's range", () => {
		expect(readViewport({ x: -120.5, y: 40, zoom: -0.5 }, -3.3, 1)).toEqual({ x: -120.5, y: 40, zoom: -0.5 });
		expect(readViewport({ x: 0, y: 0, zoom: 7 }, -3.3, 1)).toEqual({ x: 0, y: 0, zoom: 1 });
	});

	test("anything else is no viewport", () => {
		expect(readViewport(undefined, -3.3, 1)).toBeNull();
		expect(readViewport({ x: 1, y: "2", zoom: 0 }, -3.3, 1)).toBeNull();
		expect(readViewport({ x: 1, y: 2, zoom: Number.NaN }, -3.3, 1)).toBeNull();
	});
});

// Cards snap while they move or resize when Obsidian's canvas options say
// so; a wrong snap puts cards off the grid or skews alignments.
describe("snapping", () => {
	const other = { x: 100, y: 200, width: 200, height: 100 };

	test("a moving card lines up its left, centre or right with another card's; else its corner goes on the grid", () => {
		const snap = { grid: 20, others: [other], threshold: 8 };
		// Its centre (x 196 + 50) comes within 8 of the other's centre (200).
		expect(snapMove({ x: 146, y: 13, width: 100, height: 40 }, snap)).toEqual({ x: 150, y: 20 });
		// Its top meets the other's bottom (300); x is far from every line.
		expect(snapMove({ x: 433, y: 305, width: 50, height: 50 }, snap)).toEqual({ x: 440, y: 300 });
	});

	test("with objects off only the grid applies, with the grid off only objects", () => {
		expect(snapMove({ x: 146, y: 13, width: 100, height: 40 }, { grid: 20, others: null, threshold: 8 })).toEqual({ x: 140, y: 20 });
		expect(snapMove({ x: 433, y: 13, width: 50, height: 50 }, { grid: null, others: [other], threshold: 8 })).toEqual({ x: 433, y: 13 });
	});

	test("a dragged edge snaps to another card's edge or centre, else to the grid", () => {
		expect(snapEdge(296, "x", { grid: 20, others: [other], threshold: 8 })).toBe(300);
		expect(snapEdge(253, "y", { grid: 20, others: [other], threshold: 8 })).toBe(250);
		expect(snapEdge(333, "x", { grid: 20, others: [other], threshold: 8 })).toBe(340);
	});
});
