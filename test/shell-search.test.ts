import { describe, expect, test } from "bun:test";
import { parseMetadata } from "../src/api/metadata";
import { hasTags, tagMatches, tagsMatches, tagTerms } from "../src/renderer/search";
import { queryWithTag } from "../src/renderer/tag-pane";

// Rendered tags, Bases and obsidian://search open the search pane with
// 'tag:#x'; read as text, that query found nothing. The Tags view's Mod-click
// joins more tag terms, which a note must all carry.
describe("tagTerms", () => {
	test("reads each tag with or without '#', lowercased; any other term makes no tag query", () => {
		expect(tagTerms("tag:#Course/EECS")).toEqual(["course/eecs"]);
		expect(tagTerms(" tag:math  tag:#Physics ")).toEqual(["math", "physics"]);
		expect(tagTerms("tag:#a b")).toBeNull();
		expect(tagTerms("#math")).toBeNull();
		expect(tagTerms("")).toBeNull();
	});

	test("a note must carry every tag; its rows are each tag's matches in text order", () => {
		const text = ["---", "tags: [math]", "---", "Uses #physics here", "and #math/algebra."].join("\n");
		const cache = parseMetadata(text);
		expect(hasTags(cache, ["math", "physics"])).toBe(true);
		expect(hasTags(cache, ["math", "chemistry"])).toBe(false);
		const lines = text.split("\n");
		expect(tagsMatches(cache, text, ["math", "physics"]).map((m) => lines[m.line].slice(m.from, m.to))).toEqual(["math", "#physics", "#math/algebra"]);
	});
});

// Mod-click on a tag in the Tags view adds it to the search instead of
// replacing the search.
describe("queryWithTag", () => {
	test("a tag joins a tag search once; any other search is replaced", () => {
		expect(queryWithTag("tag:#math", "#physics")).toBe("tag:#math tag:#physics");
		expect(queryWithTag("tag:#math tag:#physics", "#Math")).toBe("tag:#math tag:#physics");
		expect(queryWithTag("", "#math")).toBe("tag:#math");
		expect(queryWithTag("apples", "#math")).toBe("tag:#math");
	});
});

// The matches are the result rows; clicking one selects them in the note.
describe("tagMatches", () => {
	const rows = (text: string, tag: string) => {
		const lines = text.split("\n");
		return tagMatches(parseMetadata(text), text, tag).map((m) => [m.line, lines[m.line].slice(m.from, m.to)]);
	};

	test("body tags match ignoring case, nested tags count, a longer name does not", () => {
		const text = ["# Notes", "", "Tagged #Course and #course/eecs/281, not #courses or #mycourse."].join("\n");
		expect(rows(text, "course")).toEqual([
			[2, "#Course"],
			[2, "#course/eecs/281"],
		]);
	});

	test("frontmatter values of the tags key match in every YAML form, other keys do not", () => {
		const text = ["---", "title: course notes", "tags: [Course, other]", "aliases:", "  - course", "tag:", '  - "#course/eecs"', "---", "Body without tags."].join("\n");
		expect(rows(text, "course")).toEqual([
			[2, "Course"],
			[6, "#course/eecs"],
		]);
	});

	test("a note without the tag has no matches", () => {
		const text = ["---", "tags: other", "---", "#othertag here"].join("\n");
		expect(rows(text, "course")).toEqual([]);
	});
});
