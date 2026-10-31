import { describe, expect, test } from "bun:test";
import { BaseDocument } from "../src/api/bases/config";
import { replaceBaseBlock } from "../src/api/bases/embed";
import { impliedByFilters, type NewNote } from "../src/api/bases/new-note";

const note = (block: string) => `# Note\n\n\`\`\`base\n${block}\`\`\`\n\nAfter.\n`;

// Toolbar edits in a ```base block rewrite that block in the note; a wrong
// match would overwrite another block or the user's text.
describe("writing a base block back to its note", () => {
	test("replaces the content of the block that holds the old YAML", () => {
		const before = "views:\n  - type: table\n    name: A\n";
		const after = "views:\n  - type: table\n    name: A\n    limit: 5\n";
		expect(replaceBaseBlock(note(before), before, after)).toBe(note(after));
	});

	test("matches through ~~~ fences and indentation, and leaves other blocks alone", () => {
		const text = "```js\nviews: x\n```\n  ~~~~ base\n  filters: a\n  ~~~~\n";
		expect(replaceBaseBlock(text, "  filters: a\n", "  filters: b")).toBe("```js\nviews: x\n```\n  ~~~~ base\n  filters: b\n  ~~~~\n");
	});

	test("writes nothing when no block or more than one block holds the old YAML", () => {
		const block = "filters: x\n";
		expect(replaceBaseBlock(note("filters: y\n"), block, "filters: z")).toBeNull();
		expect(replaceBaseBlock(note(block) + note(block), block, "filters: z")).toBeNull();
	});
});

// A note created from a base's New button must show up in that base.
describe("frontmatter a new note gets from the base's filters", () => {
	const implied = (filters: unknown[]) => {
		const out: NewNote = { frontmatter: {}, tags: [] };
		impliedByFilters(filters, out);
		return out;
	};

	test("equality, hasTag and inFolder conditions that every match meets", () => {
		expect(implied(['status == "todo" && note.priority == 2', { and: ['file.hasTag("#work")', 'file.inFolder("/Projects/")'] }])).toEqual({
			frontmatter: { status: "todo", priority: 2 },
			tags: ["work"],
			folder: "Projects",
		});
	});

	test("or, not and comparisons imply nothing", () => {
		expect(implied([{ or: ['status == "a"'] }, { not: ['file.hasTag("x")'] }, "priority > 2", "file.name == 'x'", "status == other"])).toEqual({ frontmatter: {}, tags: [] });
	});
});

describe("editing a base's YAML", () => {
	// Writing a base the parser could not read would replace what the user wrote.
	test("a base with an error refuses every edit and keeps its text", () => {
		for (const text of ["# notes about this base\n- keep me\n", "filters: [unclosed\n", "views: table\n"]) {
			const doc = new BaseDocument(text);
			expect(doc.error).not.toBeNull();
			expect(() => doc.addView({ type: "cards", name: "Cards" })).toThrow();
			expect(() => doc.setIn(["formulas", "a"], "1")).toThrow();
			expect(doc.text).toBe(text);
		}
	});

	// The implicit table of a base without views must survive adding a view,
	// in the order the toolbar lists the views.
	test("adding a view to a base without views writes the implicit table first", () => {
		const doc = new BaseDocument('filters: file.inFolder("Books") # mine\n');
		const text = doc.addView({ type: "cards", name: "Cards" });
		expect(text).toContain('filters: file.inFolder("Books") # mine');
		expect(new BaseDocument(text).views.map((v) => [v.type, v.name])).toEqual([
			["table", "Table"],
			["cards", "Cards"],
		]);
		doc.setViewKey(0, "limit", 5);
		expect(new BaseDocument(doc.text).views.map((v) => v.name)).toEqual(["Table", "Cards"]);
	});

	// `formulas:` with nothing after it is common in a hand-written base.
	test("setIn fills an empty key but never replaces one that holds something else", () => {
		const doc = new BaseDocument("formulas:\nproperties: [status]\n");
		expect(new BaseDocument(doc.setIn(["formulas", "a"], "1")).config.formulas).toEqual({ a: "1" });
		expect(() => doc.setIn(["properties", "status", "displayName"], "State")).toThrow("properties");
		expect(doc.text).toBe('formulas:\n  a: "1"\nproperties: [status]\n');
	});
});

describe("editing a base's top-level keys", () => {
	// Adding a formula from the toolbar must keep the rest of the file as written.
	test("setIn adds nested keys to both the YAML and the parsed config", () => {
		const doc = new BaseDocument("formulas:\n  a: '1'\nviews:\n  - type: table\n    name: T\n    order: [file.name, status]\n");
		const text = doc.setIn(["formulas", "b"], "price * 2");
		expect(text).toBe("formulas:\n  a: '1'\n  b: price * 2\nviews:\n  - type: table\n    name: T\n    order: [file.name, status]\n");
		expect(doc.config.formulas).toEqual({ a: "1", b: "price * 2" });
		expect(new BaseDocument(doc.setIn(["formulas", "a"], undefined)).config.formulas).toEqual({ b: "price * 2" });
	});

	test("long formulas are not folded across lines", () => {
		const formula = `if(${"a && ".repeat(30)}b, "yes", "no")`;
		const text = new BaseDocument("").setIn(["formulas", "long"], formula);
		expect(text.trimEnd().split("\n")).toHaveLength(2);
		expect(new BaseDocument(text).config.formulas?.long).toBe(formula);
	});
});
