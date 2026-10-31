import { describe, expect, test } from "bun:test";
import { lineAtOffset, offsetOfLine, subpathLine } from "../src/api/markdown-preview";
import { parseMetadata } from "../src/api/metadata";

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
