import { describe, expect, test } from "bun:test";
import {
	insertProperty,
	locateFrontmatter,
	moveProperty,
	readProperties,
	removeProperty,
	renameProperty,
	replaceFrontmatter,
	setProperty,
} from "../src/api/frontmatter-edit";

// A note's YAML in the styles people write: quotes, a trailing comment, an
// unindented block list, a flow list, an empty value, a block scalar and a
// comment line between properties.
const YAML = `title: "Hello"   # greeting
tags:
- a
- "b c"
# about the aliases
aliases: [x, 'y z']
empty:
block: |
  line1
last: 3
`;

const lines = (yaml: string) => yaml.split("\n");

describe("property edits rewrite only the property they change", () => {
	test("setting a value keeps every other line byte for byte", () => {
		const out = setProperty(YAML, "empty", 5);
		expect(lines(out)).toEqual(lines(YAML).map((l) => (l === "empty:" ? "empty: 5" : l)));
	});

	test("a changed list keeps its flow style and the quoting of its items", () => {
		expect(setProperty(YAML, "aliases", ["x", "y z", "w"])).toContain("aliases: [x, 'y z', w]\n");
		expect(setProperty(YAML, "tags", ["a", "b c", "d"])).toContain('tags:\n- a\n- "b c"\n- d\n# about the aliases');
	});

	test("a changed one-line value keeps its quotes and its trailing comment", () => {
		expect(lines(setProperty(YAML, "title", "World"))[0]).toBe('title: "World"   # greeting');
	});

	test("values that YAML would read as another type are quoted", () => {
		const out = setProperty("a: x\n", "a", "12");
		expect(readProperties(out)).toEqual([["a", "12"]]);
	});

	test("a property is removed with its lines, a block scalar included", () => {
		expect(removeProperty(YAML, "block")).toBe(YAML.replace("block: |\n  line1\n", ""));
		expect(removeProperty("k: 1\n", "k")).toBe("");
	});

	test("renaming changes only the key, keeping the value as written", () => {
		expect(renameProperty(YAML, "aliases", "other names")).toBe(YAML.replace("aliases:", "other names:"));
	});

	test("renaming onto a key the YAML has changes nothing", () => {
		expect(renameProperty(YAML, "title", "last")).toBe(YAML);
	});

	test("a new property goes at the end, with block lists indented like the note's", () => {
		expect(insertProperty(YAML, "new", ["p"])).toBe(`${YAML}new:\n- p\n`);
		expect(insertProperty("x:\n  - 1\n", "new", ["p"])).toBe("x:\n  - 1\nnew:\n  - p\n");
		expect(insertProperty("", "k", null)).toBe("k:\n");
	});

	test("a property can be inserted before another, or moved", () => {
		expect(lines(insertProperty(YAML, "first", true, 0))[0]).toBe("first: true");
		const moved = moveProperty(YAML, "last", 0);
		expect(readProperties(moved)?.map(([k]) => k)).toEqual(["last", "title", "tags", "aliases", "empty", "block"]);
		expect(moved).toContain('title: "Hello"   # greeting');
	});

	test("a flow map is rewritten as a whole, keeping the values", () => {
		expect(setProperty("{a: 1, b: [x]}\n", "a", 2)).toBe("a: 2\nb:\n  - x\n");
	});

	test("YAML that is not a map of properties is left alone", () => {
		for (const bad of ["a: 1\na: 2\n", "- a\n", "a: [\n"]) {
			expect(readProperties(bad)).toBeNull();
			expect(setProperty(bad, "a", 3)).toBe(bad);
		}
	});
});

describe("frontmatter in a note", () => {
	test("the YAML range includes its last line break, also with CRLF", () => {
		const text = "---\r\na: 1\r\n---\r\nbody";
		const fm = locateFrontmatter(text)!;
		expect(text.slice(fm.yamlFrom, fm.yamlTo)).toBe("a: 1\r\n");
		expect(text.slice(fm.to)).toBe("body");
		expect(locateFrontmatter("---\n---\nbody")).toEqual({ yamlFrom: 4, yamlTo: 4, to: 8 });
		expect(locateFrontmatter("---\na: 1\nbody")).toBeNull();
	});

	test("replacing the YAML adds a block, changes it, or drops it when empty", () => {
		expect(replaceFrontmatter("body", "a: 1\n")).toBe("---\na: 1\n---\nbody");
		expect(replaceFrontmatter("---\na: 1\n---\nbody", "b: 2\n")).toBe("---\nb: 2\n---\nbody");
		expect(replaceFrontmatter("---\na: 1\n---\nbody", "")).toBe("body");
	});

	// The CLI edits the file's own text: a CRLF note must not come out with
	// some lines ending in LF.
	test("edits keep a CRLF note's line breaks on every line", () => {
		const text = "---\r\ntitle: a\r\ntags:\r\n  - x\r\n---\r\nbody\r\n";
		const fm = locateFrontmatter(text)!;
		const yaml = text.slice(fm.yamlFrom, fm.yamlTo);
		expect(replaceFrontmatter(text, setProperty(yaml, "title", "b"))).toBe("---\r\ntitle: b\r\ntags:\r\n  - x\r\n---\r\nbody\r\n");
		expect(replaceFrontmatter(text, setProperty(yaml, "tags", ["x", "y"]))).toBe("---\r\ntitle: a\r\ntags:\r\n  - x\r\n  - y\r\n---\r\nbody\r\n");
		expect(replaceFrontmatter(text, insertProperty(yaml, "new", "v"))).toBe("---\r\ntitle: a\r\ntags:\r\n  - x\r\nnew: v\r\n---\r\nbody\r\n");
		expect(replaceFrontmatter("body\r\nmore\r\n", setProperty("", "a", 1))).toBe("---\r\na: 1\r\n---\r\nbody\r\nmore\r\n");
		expect(setProperty("- not a map\r\n", "a", 1)).toBe("- not a map\r\n");
	});
});
