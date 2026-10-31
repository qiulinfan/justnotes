import { describe, expect, test } from "bun:test";
import MarkdownIt from "markdown-it";
import { BaseDocument } from "../src/api/bases/config";
import { replaceBaseBlock } from "../src/api/bases/embed";
import { impliedByFilters, type NewNote } from "../src/api/bases/new-note";

const note = (block: string) => `# Note\n\n\`\`\`base\n${block}\`\`\`\n\nAfter.\n`;

// What the renderer hands a ```base block's processor: markdown-it's fence
// content, with the indentation and ">" of list items and quotes removed.
const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
const blockSource = (text: string) => md.parse(text, {}).find((t) => t.type === "fence" && t.info.trim() === "base")?.content;

// Toolbar edits in a ```base block rewrite that block in the note; a wrong
// match would overwrite another block or the user's text.
describe("writing a base block back to its note", () => {
	test("replaces the content of the block that holds the old YAML", () => {
		const before = "views:\n  - type: table\n    name: A\n";
		const after = "views:\n  - type: table\n    name: A\n    limit: 5\n";
		expect(replaceBaseBlock(note(before), before, after)).toBe(note(after));
	});

	// A block in a list item or a quote is found from the source the renderer
	// gives, and the new YAML keeps the block's indentation and markers.
	test("blocks in list items and quotes are written back in place", () => {
		const cases = [
			["- tasks\n\n  ```base\n  views:\n    - type: table\n      name: A\n  ```\n", "- tasks\n\n  ```base\n  views:\n    - type: table\n      name: A\n      limit: 5\n  ```\n"],
			["- ```base\n  views:\n    - type: table\n      name: A\n  ```\n", "- ```base\n  views:\n    - type: table\n      name: A\n      limit: 5\n  ```\n"],
			[
				"1. item\n   > ~~~~ base\n   > views:\n   >\n   >   - type: table\n   >     name: A\n   > ~~~~\n\nAfter.\n",
				"1. item\n   > ~~~~ base\n   > views:\n   >\n   >   - type: table\n   >     name: A\n   >     limit: 5\n   > ~~~~\n\nAfter.\n",
			],
		];
		for (const [text, expected] of cases) {
			const before = blockSource(text)!;
			const written = replaceBaseBlock(text, before, before.replace("name: A", "name: A\n    limit: 5"));
			expect(written).toBe(expected);
			expect(blockSource(written!)).toBe(before.replace("name: A", "name: A\n    limit: 5"));
		}
	});

	test("leaves other code blocks alone and keeps CRLF line ends", () => {
		const text = "```js\nviews: x\n```\r\n~~~ base\r\nfilters: a\r\n~~~\r\n";
		expect(replaceBaseBlock(text, blockSource(text)!, "filters: b\n")).toBe("```js\nviews: x\n```\r\n~~~ base\r\nfilters: b\r\n~~~\r\n");
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
