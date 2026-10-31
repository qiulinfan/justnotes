import { describe, expect, test } from "bun:test";
import { parseMetadata } from "../src/api/metadata";
import { moment } from "../src/api/util";
import { dailyNoteDate, dailyNotePath } from "../src/renderer/daily-notes";
import { lineDiff, snapshotDue } from "../src/renderer/file-recovery";
import { findMentions, headingAt, headingTree, mentionSkips, outlineMatches } from "../src/renderer/link-panes";
import { addText, composeText, headingSection, mergeText, noteName, sectionReplacement } from "../src/renderer/note-composer";
import { contentScale, slideSources } from "../src/renderer/slides";
import { sortTags, type TagNode, tagTree } from "../src/renderer/tag-pane";
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

describe("tags view", () => {
	const shape = (nodes: TagNode[]): unknown[] => nodes.map((n) => (n.children.length ? [`${n.name} ${n.count}`, shape(n.children)] : `${n.name} ${n.count}`));

	test("nested tags form a tree whose counts are the notes under each tag, a tag repeated in one note counted once, under its first spelling", () => {
		const notes = [["#proj/alpha", "#proj/alpha", "#Proj"], ["#proj/beta/x"], ["#idea"]];
		expect(shape(sortTags(tagTree(notes, true), "alphabetical"))).toEqual(["idea 1", ["proj 2", ["alpha 1", ["beta 1", ["x 1"]]]]]);
	});

	test("the flat list keeps each full tag; spellings differing in case are one tag", () => {
		expect(shape(sortTags(tagTree([["#a/b", "#A/B"], ["#a/B"]], false), "alphabetical"))).toEqual(["#a/b 2"]);
	});

	test("frequency sorts by count, ties by name; the reverse orders flip", () => {
		const roots = tagTree([["#b", "#c"], ["#c"], ["#a"]], true);
		expect(shape(sortTags(roots, "frequency"))).toEqual(["c 2", "a 1", "b 1"]);
		expect(shape(sortTags(roots, "frequencyReverse"))).toEqual(["a 1", "b 1", "c 2"]);
		expect(shape(sortTags(roots, "alphabeticalReverse"))).toEqual(["c 2", "b 1", "a 1"]);
	});
});

describe("note composer", () => {
	const vars = { content: "Body {{date}}", fromTitle: "Old", newTitle: "New", date: moment("2026-10-31", "YYYY-MM-DD") };

	test("a template fills its variables; the content goes where {{content}} is and is left as written", () => {
		expect(composeText("# {{newTitle}}\nfrom [[{{fromTitle}}]] on {{date:MMM D}}\n{{content}}\n", vars)).toBe("# New\nfrom [[Old]] on Oct 31\nBody {{date}}\n");
	});

	test("without {{content}} the content goes under the template; without a template it goes alone", () => {
		expect(composeText("## From {{fromTitle}}\n\n", vars)).toBe("## From Old\n\nBody {{date}}");
		expect(composeText(null, vars)).toBe("Body {{date}}");
	});

	test("text goes at the end after a blank line, or at the start below the frontmatter", () => {
		expect(addText("A\n\n\n", "B\n", "end")).toBe("A\n\nB\n");
		expect(addText("---\ntags: x\n---\nA\n", "B", "start")).toBe("---\ntags: x\n---\nB\n\nA\n");
		expect(addText("", "B", "start")).toBe("B\n");
	});

	test("a merged note's frontmatter joins the destination's, adding only the properties it lacks", () => {
		expect(mergeText("---\ntags: b\n---\nB\n", "---\ntags: a\nsource: x\n---\nA\n", "end")).toBe("---\ntags: b\nsource: x\n---\nB\n\nA\n");
		expect(mergeText("B\n", "---\ntags: a\n---\nA\n", "end")).toBe("---\ntags: a\n---\nB\n\nA\n");
	});

	test("a heading's section runs to the next heading of the same or a higher level", () => {
		const text = ["# Top", "intro", "## Part", "", "body", "### Sub", "deep", "## Next", "tail"].join("\n");
		const section = headingSection(text, 4)!;
		expect(section.heading.heading).toBe("Part");
		expect(text.slice(section.from, section.to)).toBe("## Part\n\nbody\n### Sub\ndeep\n");
		expect(section.body).toBe("body\n### Sub\ndeep");
		expect(headingSection("text\n# A", 0)).toBeNull();
	});

	test("the link keeps the blank line before the next heading; with nothing left behind the section just goes", () => {
		const text = "## A\nx\n## B\n";
		const section = headingSection(text, 0)!;
		const replace = (link: string) => text.slice(0, section.from) + sectionReplacement(text, section, link) + text.slice(section.to);
		expect(replace("[[A]]")).toBe("[[A]]\n\n## B\n");
		expect(replace("")).toBe("## B\n");
	});

	test("a note name drops what links and file systems reject", () => {
		expect(noteName(" Limits: [part] #1 / x ")).toBe("Limits part 1 x");
	});
});

describe("file recovery", () => {
	const minute = 60_000;

	test("a note is snapshotted at once without a recent snapshot, else when the interval ends, never unchanged", () => {
		expect(snapshotDue(null, "a", 0, 5 * minute)).toBe("now");
		expect(snapshotDue({ ts: 0, data: "a" }, "b", 6 * minute, 5 * minute)).toBe("now");
		expect(snapshotDue({ ts: 0, data: "a" }, "b", 2 * minute, 5 * minute)).toBe(5 * minute);
		expect(snapshotDue({ ts: 0, data: "a" }, "a", 60 * minute, 5 * minute)).toBe("skip");
	});

	test("changes list kept, removed and added lines in order, a changed line as removed then added", () => {
		const shape = (a: string, b: string) => lineDiff(a, b).map((l) => `${l.type === "same" ? " " : l.type === "added" ? "+" : "-"}${l.text}`);
		expect(shape("a\nb\nc", "a\nB\nc\nd")).toEqual([" a", "-b", "+B", " c", "+d"]);
		expect(shape("x\ny", "y")).toEqual(["-x", " y"]);
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

	// The cursor of a note just opened (justnotes template:insert) is at 0,
	// before the note's properties; inserting there broke the frontmatter.
	test("a template without frontmatter never goes inside or above the note's frontmatter", () => {
		expect(insert("---\na: 1\n---\nText\n", 0, "# T\n")).toBe("---\na: 1\n---\n# T\nText\n");
		expect(insert("---\na: 1\n---", 2, "X")).toBe("---\na: 1\n---\nX");
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

describe("slides", () => {
	test("a note splits at its top-level --- rules; the frontmatter is no slide", () => {
		const note = ["---", "title: Talk", "---", "# One", "", "---", "", "## Two", "text", "", "- - -", "", "Three"].join("\n");
		expect(slideSources(note)).toEqual(["# One", "## Two\ntext", "Three"]);
	});

	test("--- under a paragraph, in code, in math or in a quote, and other rules, divide nothing", () => {
		const note = ["Heading", "---", "", "```", "a", "---", "b", "```", "", "$$", "x", "---", "$$", "", "> q", "> ---", "", "***", "", "end"].join("\n");
		expect(slideSources(note)).toEqual([note]);
	});

	test("empty slides are dropped; a note with no text is one empty slide", () => {
		expect(slideSources("A\n\n---\n\n---\n\nB\n\n---\n")).toEqual(["A", "B"]);
		expect(slideSources("---\ntags: x\n---\n")).toEqual([""]);
	});

	test("content larger than its slide shrinks to fit, never grows, and scrolls past the minimum scale", () => {
		expect(contentScale(800, 300, 960, 700)).toEqual({ scale: 1, scrolls: false });
		expect(contentScale(960, 1400, 960, 700)).toEqual({ scale: 0.5, scrolls: false });
		expect(contentScale(1200, 700, 960, 700)).toEqual({ scale: 0.8, scrolls: false });
		expect(contentScale(960, 3500, 960, 700)).toEqual({ scale: 0.5, scrolls: true });
	});
});
