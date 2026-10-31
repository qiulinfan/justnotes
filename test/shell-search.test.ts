import { describe, expect, test } from "bun:test";
import { parseMetadata } from "../src/api/metadata";
import { tagMatches, tagQuery } from "../src/renderer/search";

// Rendered tags, Bases and obsidian://search open the search pane with
// 'tag:#x'; read as text, that query found nothing.
describe("tagQuery", () => {
	test("reads the tag with or without '#', lowercased; anything else is no tag query", () => {
		expect(tagQuery("tag:#Course/EECS")).toBe("course/eecs");
		expect(tagQuery("tag:math")).toBe("math");
		expect(tagQuery("tag:#a b")).toBeNull();
		expect(tagQuery("#math")).toBeNull();
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
