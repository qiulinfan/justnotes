import { describe, expect, test } from "bun:test";
import { parseMetadata } from "../src/api/metadata";
import { moment } from "../src/api/util";
import { dailyNoteDate, dailyNotePath } from "../src/renderer/daily-notes";
import { findMentions, headingAt, headingTree, mentionSkips, outlineMatches } from "../src/renderer/link-panes";
import { fillTemplate, templateEdits } from "../src/renderer/templates";
import { countWords } from "../src/renderer/word-count";

// The rows of the backlinks pane's unlinked mentions (and the outgoing links
// pane's), each a mention a Link button turns into a link.
describe("unlinked mentions", () => {
	const mentions = (text: string, names: string[]) => {
		const lines = text.split("\n");
		return findMentions(text, names, mentionSkips(parseMetadata(text))).map((m) => [m.line, lines[m.line].slice(m.from, m.to)]);
	};

	test("a name matches ignoring case, only as a whole word", () => {
		expect(mentions("Topology is fun.\nalgebraic topology, topologyX and xtopology", ["Topology"])).toEqual([
			[0, "Topology"],
			[1, "topology"],
		]);
	});

	test("names inside links, embeds, frontmatter and code are no mentions", () => {
		const text = ["---", "title: Topology", "---", "See [[Topology]] and ![[Topology]] and [Topology](Topology.md).", "```", "Topology", "```", "But Topology here."].join("\n");
		expect(mentions(text, ["Topology"])).toEqual([[7, "Topology"]]);
	});

	test("next to Chinese or Japanese characters a name still stands alone", () => {
		expect(mentions("今天学了流形和Manifold理论", ["流形", "Manifold"])).toEqual([
			[0, "流形"],
			[0, "Manifold"],
		]);
	});

	test("of overlapping names (a note and its alias) the longer one counts once", () => {
		expect(mentions("Smooth Manifold notes", ["Manifold", "Smooth Manifold"])).toEqual([[0, "Smooth Manifold"]]);
	});
});

describe("outline", () => {
	test("deeper headings nest under the heading before them, a skipped level included", () => {
		const cache = parseMetadata(["# A", "### A.1", "## A.2", "#### A.2.1", "# B"].join("\n"));
		const shape = (nodes: ReturnType<typeof headingTree>): unknown[] => nodes.map((n) => (n.children.length ? [n.heading.heading, shape(n.children)] : n.heading.heading));
		expect(shape(headingTree(cache.headings ?? []))).toEqual([["A", ["A.1", ["A.2", ["A.2.1"]]]], "B"]);
	});

	test("the cursor is under the last heading at or above its line; above the first, under none", () => {
		const headings = parseMetadata(["intro", "# A", "text", "## B", "# C"].join("\n")).headings ?? [];
		expect([0, 1, 2, 3, 4].map((line) => headingAt(headings, line))).toEqual([-1, 0, 0, 1, 2]);
	});

	test("a search keeps matching headings and the headings above them, ignoring case", () => {
		const roots = headingTree(parseMetadata(["# Limits", "## Squeeze", "## Uniqueness", "# Series", "## Limit tests"].join("\n")).headings ?? []);
		const shown = outlineMatches(roots, "LIMIT");
		const names = (nodes: typeof roots): string[] => nodes.flatMap((n) => [...(shown?.has(n) ? [n.heading.heading] : []), ...names(n.children)]);
		expect(names(roots)).toEqual(["Limits", "Series", "Limit tests"]);
		expect(outlineMatches(roots, "  ")).toBeNull();
	});
});

describe("template variables", () => {
	const vars = { title: "Lecture 3", date: moment("2026-10-31 14:05", "YYYY-MM-DD HH:mm"), dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" };

	test("title, date and time fill in, with their own format when given", () => {
		expect(fillTemplate("# {{title}}\n{{date}} {{time}} {{date:dddd}} {{ time : h A }}", vars)).toBe("# Lecture 3\n2026-10-31 14:05 Saturday 2 PM");
	});

	test("yesterday and tomorrow are the days around the date; other names stay", () => {
		expect(fillTemplate("{{yesterday}} {{tomorrow}} {{author}}", vars)).toBe("2026-10-30 2026-11-01 {{author}}");
	});
});

describe("inserting a template", () => {
	const insert = (doc: string, at: number, template: string) => {
		let out = doc;
		for (const e of [...templateEdits(doc, at, at, template)].reverse()) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
		return out;
	};

	test("a template without frontmatter goes in at the cursor", () => {
		expect(insert("ab", 1, "X")).toBe("aXb");
	});

	test("a template's frontmatter goes to the top of a note without any", () => {
		expect(insert("Intro\n", 6, "---\ntags: lecture\n---\nBody\n")).toBe("---\ntags: lecture\n---\nIntro\nBody\n");
	});

	test("properties the note has keep their values; new ones are added", () => {
		const doc = "---\ntags: mine\n---\nText\n";
		expect(insert(doc, doc.length, "---\ntags: lecture\naliases:\n  - L3\n---\nBody\n")).toBe("---\ntags: mine\naliases:\n  - L3\n---\nText\nBody\n");
	});

	test("the body never lands inside the note's frontmatter", () => {
		expect(insert("---\na: 1\n---", 4, "---\nb: 2\n---\nBody")).toBe("---\na: 1\nb: 2\n---\nBody");
	});
});

describe("daily notes", () => {
	const day = moment("2026-10-31", "YYYY-MM-DD");

	test("the note's path follows the folder and format, which may name folders", () => {
		expect(dailyNotePath({}, day)).toBe("2026-10-31.md");
		expect(dailyNotePath({ folder: "Journal/", format: "YYYY/MM/YYYY-MM-DD" }, day)).toBe("Journal/2026/10/2026-10-31.md");
	});

	test("only notes in the folder whose name reads exactly in the format are daily notes", () => {
		const options = { folder: "Journal", format: "YYYY-MM-DD" };
		expect(dailyNoteDate(options, "Journal/2026-10-31.md")?.format("YYYY-MM-DD")).toBe("2026-10-31");
		expect(dailyNoteDate(options, "2026-10-31.md")).toBeNull();
		expect(dailyNoteDate(options, "Journal/2026-10-31 notes.md")).toBeNull();
	});
});

describe("word count", () => {
	test("each Chinese character is a word, punctuation alone is none, line breaks are no characters", () => {
		expect(countWords("学习 smooth manifolds — 今天\nok")).toEqual({ words: 7, characters: 26 });
	});
});
