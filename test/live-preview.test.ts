import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { type Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { obsidianMarkdown } from "../src/api/editor-extensions";
import { type LivePreviewHost, livePreview, tableCellOffset } from "../src/api/live-preview";

const host = {
	app: {
		vault: { getConfig: () => undefined, on: () => ({}), offref() {} },
		metadataCache: { getFirstLinkpathDest: (path: string) => (path === "Known" ? {} : null), getCache: () => null },
	},
	sourcePath: () => "note.md",
	resolveImage: () => null,
} as unknown as LivePreviewHost;

interface Deco {
	from: number;
	to: number;
	line?: string;
	attrs?: Record<string, string>;
	mark?: string;
	widget?: string;
	block?: boolean;
}

// Every decoration Live Preview produces, with the cursor at `cursor`.
function decorate(doc: string, cursor: number): Deco[] {
	const state = EditorState.create({
		doc,
		selection: { anchor: cursor },
		extensions: [markdown({ base: markdownLanguage, extensions: obsidianMarkdown }), livePreview(host)],
	});
	const out: Deco[] = [];
	for (const set of state.facet(EditorView.decorations) as DecorationSet[]) {
		set.between(0, doc.length, (from, to, value: Decoration) => {
			const spec = value.spec;
			if (spec.class && from === to && !spec.widget) out.push({ from, to, line: spec.class, attrs: spec.attributes });
			else if (spec.class) out.push({ from, to, mark: spec.class, attrs: spec.attributes });
			else out.push({ from, to, widget: spec.widget?.constructor.name ?? "hidden", block: !!spec.block });
		});
	}
	return out;
}

const lineClass = (decos: Deco[], doc: string, line: number) => {
	const from = doc.split("\n").slice(0, line).join("\n").length + (line ? 1 : 0);
	return decos.filter((d) => d.line && d.from === from).map((d) => d.line).join(" ");
};

describe("reveal rule", () => {
	const doc = "plain **bold** text\nnext line";

	test("inline marks are hidden away from the cursor", () => {
		const hidden = decorate(doc, doc.length).filter((d) => d.widget === "hidden");
		expect(hidden.map((d) => doc.slice(d.from, d.to))).toEqual(["**", "**"]);
	});

	test("a cursor touching the element shows its marks", () => {
		expect(decorate(doc, doc.indexOf("bold")).filter((d) => d.widget === "hidden")).toEqual([]);
	});
});

// Themes and plugin CSS target Obsidian's HyperMD line classes.
describe("line classes", () => {
	test("lists carry their depth, tasks their status", () => {
		const doc = "- one\n\t- two\n- [/] half\n\nend";
		const decos = decorate(doc, doc.length);
		expect(lineClass(decos, doc, 0)).toBe("HyperMD-list-line HyperMD-list-line-1");
		expect(lineClass(decos, doc, 1)).toBe("HyperMD-list-line HyperMD-list-line-2");
		expect(lineClass(decos, doc, 2)).toBe("HyperMD-list-line HyperMD-list-line-1 HyperMD-task-line");
		expect(decos.find((d) => d.line?.includes("HyperMD-task-line"))?.attrs).toEqual({ "data-task": "/" });
	});

	test("quote lines carry their own depth only", () => {
		const doc = "> outer\n> > inner\n\nend";
		const decos = decorate(doc, doc.length);
		expect(lineClass(decos, doc, 0)).toBe("HyperMD-quote HyperMD-quote-1");
		expect(lineClass(decos, doc, 1)).toBe("HyperMD-quote HyperMD-quote-2");
	});

	test("fenced code marks its first and last lines", () => {
		const doc = "```js\nx\n```\n\nend";
		const decos = decorate(doc, doc.length);
		expect(lineClass(decos, doc, 0)).toContain("HyperMD-codeblock-begin");
		expect(lineClass(decos, doc, 1)).toBe("HyperMD-codeblock HyperMD-codeblock-bg");
		expect(lineClass(decos, doc, 2)).toContain("HyperMD-codeblock-end");
	});
});

describe("block widgets", () => {
	const doc = "---\ntitle: x\n---\n| a | b |\n| - | - |\n| 1 | 2 |\n\nend";
	const blocks = (cursor: number) => decorate(doc, cursor).filter((d) => d.block).map((d) => [d.widget, doc.slice(d.from, d.to)]);

	test("frontmatter and tables render while the selection is elsewhere", () => {
		expect(blocks(doc.length)).toEqual([
			["PropertiesWidget", "---\ntitle: x\n---"],
			["RenderedBlockWidget", "| a | b |\n| - | - |\n| 1 | 2 |"],
		]);
	});

	test("a selection inside shows the source", () => {
		expect(blocks(doc.indexOf("title"))).toEqual([["RenderedBlockWidget", "| a | b |\n| - | - |\n| 1 | 2 |"]]);
		expect(blocks(doc.indexOf("| 1"))).toEqual([["PropertiesWidget", "---\ntitle: x\n---"]]);
	});
});

describe("links", () => {
	test("wikilinks to missing notes are marked unresolved", () => {
		const doc = "[[Known]] and [[Missing]]\nend";
		const links = decorate(doc, doc.length).filter((d) => d.mark?.includes("cm-underline"));
		expect(links.map((d) => [doc.slice(d.from, d.to), d.mark])).toEqual([
			["Known", "cm-underline"],
			["Missing", "cm-underline is-unresolved"],
		]);
	});
});

// A click on a rendered table cell must land in that cell's source.
describe("tableCellOffset", () => {
	const at = (source: string, row: number, col: number) => source.slice(tableCellOffset(source, row, col)).charAt(0);

	test("maps header and body cells past the delimiter line", () => {
		const source = "| a | b |\n| - | - |\n| 1 | 2 |";
		expect([at(source, 0, 1), at(source, 1, 0), at(source, 1, 1)]).toEqual(["b", "1", "2"]);
	});

	test("handles rows without outer pipes and escaped pipes", () => {
		expect(at("a | b\n--|--\n1 | 2", 1, 1)).toBe("2");
		expect(at("| a \\| x | b |\n|-|-|", 0, 1)).toBe("b");
	});
});
