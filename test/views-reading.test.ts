import { describe, expect, test } from "bun:test";
import { headingLines, lineAtOffset, offsetOfLine, subpathLine } from "../src/api/markdown-preview";
import { parseMetadata } from "../src/api/metadata";

// The reading view keeps the reading position when switching modes by
// matching rendered headings to these source lines; a wrong line count makes
// the position jump.
describe("headingLines", () => {
	test("skips frontmatter and code, counts setext and quoted headings", () => {
		const text = [
			"---",
			"# not a heading: frontmatter",
			"---",
			"# Title",
			"```bash",
			"# a shell comment",
			"```",
			"Setext title",
			"===",
			"> ## In a quote",
			"- a list item",
			"---",
			"#hashtag is not a heading",
		].join("\n");
		expect(headingLines(text)).toEqual([3, 7, 9]);
	});
});

describe("lineAtOffset / offsetOfLine", () => {
	const anchors: [number, number][] = [
		[10, 400],
		[50, 1000],
	];

	test("a heading line maps to where the heading is rendered, and back", () => {
		expect(offsetOfLine(anchors, 50, 100, 3000)).toBe(1000);
		expect(lineAtOffset(anchors, 1000, 100, 3000)).toBe(50);
	});

	test("positions between headings interpolate", () => {
		expect(offsetOfLine(anchors, 30, 100, 3000)).toBe(700);
		expect(lineAtOffset(anchors, 700, 100, 3000)).toBe(30);
	});

	test("without anchors the mapping is proportional", () => {
		expect(offsetOfLine([], 25, 100, 2000)).toBe(500);
	});
});

// openLinkText and history pass `#Heading`, `#Parent#Child` and `#^block`
// subpaths; the view scrolls to the line they name.
describe("subpathLine", () => {
	const cache = parseMetadata(["# Intro", "## Setup", "text ^anchor", "# Usage", "## Setup", "more"].join("\n"));

	test("a nested heading path finds the child under the named parent", () => {
		expect(subpathLine(cache, "#Usage#Setup")).toBe(4);
		expect(subpathLine(cache, "#Setup")).toBe(1);
	});

	test("block references and heading case and spacing", () => {
		expect(subpathLine(cache, "#^anchor")).toBe(2);
		expect(subpathLine(cache, "#usage")).toBe(3);
	});

	test("an unknown subpath has no line", () => {
		expect(subpathLine(cache, "#Missing")).toBeNull();
	});
});
