import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { type Highlight, highlightsPath, locate, parseHighlights, writeHighlights } from "../src/renderer/epub/highlights";
import { spanOf, textIndex } from "../src/renderer/epub/text-index";

const dom = new JSDOM("<!doctype html><html><body></body></html>");

const one = (over: Partial<Highlight> = {}): Highlight => ({
	path: "text/ch1.xhtml",
	offset: 10,
	quote: "the words",
	color: "yellow",
	style: "highlight",
	label: "Chapter One",
	note: "",
	...over,
});

const byPath = (h: Highlight) => ["text/ch1.xhtml", "text/ch2.xhtml"].indexOf(h.path);

describe("highlights note", () => {
	test("lives beside the book", () => {
		expect(highlightsPath("Books/Book.epub")).toBe("Books/Book.highlights.md");
		expect(highlightsPath("Book.EPUB")).toBe("Book.highlights.md");
	});

	test("a highlight is a callout of its colour linking back, its note after it", () => {
		const text = writeHighlights({ preamble: "", entries: [one({ style: "wavy", note: "Mine." })] }, "Book.epub", byPath);
		expect(text).toBe("> [!yellow|wavy] [[Book.epub#text/ch1.xhtml:10|Chapter One]]\n> the words\n\nMine.\n");
		expect(parseHighlights(text).entries).toEqual([one({ style: "wavy", note: "Mine." })]);
	});

	test("in the book's order, the reader's own text kept", () => {
		const doc = {
			preamble: "# My reading\n\nThoughts first.",
			entries: [one({ path: "text/ch2.xhtml", offset: 5, label: "Two", note: "Later.\n\n- a list" }), one({ offset: 90, color: "blue" }), one()],
		};
		const text = writeHighlights(doc, "Book.epub", byPath);
		const back = parseHighlights(text);
		expect(back.preamble).toBe("# My reading\n\nThoughts first.");
		expect(back.entries.map((h) => `${h.path}:${h.offset}`)).toEqual(["text/ch1.xhtml:10", "text/ch1.xhtml:90", "text/ch2.xhtml:5"]);
		expect(back.entries[2].note).toBe("Later.\n\n- a list");
	});

	test("a note written in the file by hand is the highlight's", () => {
		const text = "> [!green] [[Book.epub#text/ch1.xhtml:3|One]]\n> some quote\nWritten right under.\n\nAnd more.\n> [!pink|underline] [[Book.epub#text/ch1.xhtml:40]]\n> second\n";
		const doc = parseHighlights(text);
		expect(doc.entries.map((h) => [h.color, h.style, h.note])).toEqual([
			["green", "highlight", "Written right under.\n\nAnd more."],
			["pink", "underline", ""],
		]);
	});

	test("what would format the quote is escaped, and read back as it was", () => {
		const quote = "a *star*, [[not a link]], <b> | 50% #tag $x$ ^";
		const text = writeHighlights({ preamble: "", entries: [one({ quote })] }, "Book.epub", byPath);
		expect(text).toContain("> a \\*star\\*, \\[\\[not a link\\]\\], \\<b\\> \\| 50% \\#tag \\$x\\$ \\^");
		expect(parseHighlights(text).entries[0].quote).toBe(quote);
	});

	test("a callout of another kind is the reader's text", () => {
		const doc = parseHighlights("> [!note] Mine\n> text\n");
		expect(doc.entries).toEqual([]);
		expect(doc.preamble).toBe("> [!note] Mine\n> text");
	});

	test("found again by its quote, the occurrence nearest where it was", () => {
		const index = { text: "one two one two one", nodes: [], offsets: [] };
		expect(locate(index, one({ quote: "one", offset: 9 }))).toBe(8);
		expect(locate(index, one({ quote: "one", offset: 30 }))).toBe(16);
		expect(locate(index, one({ quote: "three" }))).toBeNull();
	});

	test("a selection as the chapter's text sees it, across blocks", () => {
		const doc = new dom.window.DOMParser().parseFromString("<body><p>Alpha beta</p><p>gamma <em>delta</em></p></body>", "text/html") as unknown as Document;
		const index = textIndex(doc.body);
		const range = doc.createRange();
		const [p1, p2] = Array.from(doc.querySelectorAll("p"));
		range.setStart(p1.firstChild!, 6);
		range.setEnd(p2.querySelector("em")!.firstChild!, 3);
		const [start, end] = spanOf(index, range);
		expect(index.text.slice(start, end + 1)).toBe("beta gamma del");
	});
});
