import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { type Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { obsidianMarkdown } from "../src/api/editor-extensions";
import { clickableTokenAt, editorLivePreviewField, type LivePreviewHost, livePreview, tableCellOffset } from "../src/api/live-preview";

const host = {
	app: {
		vault: { getConfig: () => undefined, on: () => ({}), offref() {} },
		metadataCache: { getFirstLinkpathDest: (path: string) => (path === "Known" ? {} : null), getCache: () => null },
	},
	sourcePath: () => "note.md",
	resolveImage: (link: string) => (link.endsWith(".png") ? `app://vault/${link}` : null),
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

function stateOf(doc: string, cursor: number, ...extensions: Extension[]) {
	return EditorState.create({
		doc,
		selection: { anchor: cursor },
		extensions: [...extensions, markdown({ base: markdownLanguage, extensions: obsidianMarkdown }), livePreview(host)],
	});
}

// Every decoration Live Preview produces, with the cursor at `cursor`.
const decorate = (doc: string, cursor: number) => decorations(stateOf(doc, cursor));

function decorations(state: EditorState): Deco[] {
	const out: Deco[] = [];
	for (const set of state.facet(EditorView.decorations) as DecorationSet[]) {
		set.between(0, state.doc.length, (from, to, value: Decoration) => {
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

	test("footnote definitions are footnote lines", () => {
		const doc = "a[^1]\n\n[^1]: note\nend";
		const decos = decorate(doc, doc.length);
		expect(lineClass(decos, doc, 0)).toBe("");
		expect(lineClass(decos, doc, 2)).toBe("HyperMD-footnote");
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

	test("an <img> on a line of its own renders as an image", () => {
		const html = 'text\n\n<img src="a.png" width="650">\n\nmore';
		const images = decorate(html, html.length).filter((d) => d.widget === "HtmlImageWidget");
		expect(images.map((d) => html.slice(d.from, d.to))).toEqual(['<img src="a.png" width="650">']);
	});

	// Before, any HTML block but a lone <img> stayed source, so a centred image
	// in <p align="center"> never showed.
	test("other HTML blocks render while the cursor is outside their lines", () => {
		const html = 'text\n\n<p align="center"><img src="a.png"></p>\n\n<div>\nx\n</div>\n\nmore';
		const rendered = (cursor: number) => decorate(html, cursor).filter((d) => d.block && d.widget === "RenderedBlockWidget").map((d) => html.slice(d.from, d.to));
		expect(rendered(html.length)).toEqual(['<p align="center"><img src="a.png"></p>', "<div>\nx\n</div>"]);
		expect(rendered(html.indexOf("x\n"))).toEqual(['<p align="center"><img src="a.png"></p>']);
	});
});

// A note opens with the cursor at offset 0, which is inside its frontmatter.
describe("frontmatter reveal", () => {
	const doc = "---\ntitle: x\n---\nbody";
	const properties = (state: EditorState) => decorations(state).some((d) => d.widget === "PropertiesWidget");
	const moveTo = (state: EditorState, pos: number, userEvent?: string) => state.update({ selection: { anchor: pos }, userEvent }).state;
	const inBody = stateOf(doc, doc.indexOf("body"));

	test("a cursor placed at offset 0 without user input keeps the Properties block", () => {
		expect(properties(stateOf(doc, 0))).toBe(true);
		expect(properties(moveTo(inBody, 0))).toBe(true);
	});

	test("the user moving in reveals the YAML, which stays revealed at its first column", () => {
		expect(properties(moveTo(inBody, 0, "select"))).toBe(false);
		const editing = moveTo(stateOf(doc, 0), doc.indexOf("title"), "select.pointer");
		expect(properties(moveTo(editing, 0))).toBe(false);
		expect(properties(moveTo(editing, doc.indexOf("body")))).toBe(true);
	});
});

// The view turns editorLivePreviewField off for source mode: every mark then
// shows and nothing renders, while line classes stay for themes.
describe("source mode", () => {
	const doc = "# Head **bold** $x$\n\nend";
	const rendered = (state: EditorState) => decorations(state).filter((d) => d.widget).map((d) => d.widget);

	test("hides and renders nothing but keeps line classes", () => {
		const state = stateOf(doc, doc.length, editorLivePreviewField.init(() => false));
		expect(rendered(state)).toEqual([]);
		expect(lineClass(decorations(state), doc, 0)).toBe("HyperMD-header HyperMD-header-1");
	});

	test("switching the mode rebuilds the decorations", () => {
		const mode = new Compartment();
		const live = stateOf(doc, doc.length, mode.of(editorLivePreviewField.init(() => true)));
		expect(rendered(live)).toEqual(["hidden", "hidden", "hidden", "MathWidget"]);
		expect(rendered(live.update({ effects: mode.reconfigure(editorLivePreviewField.init(() => false)) }).state)).toEqual([]);
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

	// [a](<path with spaces.md>) is how links to such paths are written; the
	// brackets once stayed in the target, which then never resolved.
	test("a destination in angle brackets links and embeds without its brackets", () => {
		const doc = "[a](<Known>) ![x](<my pic.png>)\nend";
		const decos = decorate(doc, doc.length);
		expect(decos.find((d) => d.mark?.includes("cm-underline"))).toMatchObject({ mark: "cm-underline", attrs: { "data-href": "Known" } });
		expect(decos.filter((d) => d.widget === "ImageWidget").map((d) => doc.slice(d.from, d.to))).toEqual(["![x](<my pic.png>)"]);
		expect(clickableTokenAt(stateOf(doc, 0), 1)).toEqual({ type: "internal-link", text: "Known", from: 0, to: 12 });
	});

	// A README's badge, [![alt](img)](url), and formatted link text render
	// inside the link, as in the reading view, instead of showing their source.
	test("an image or formatting in a link's text renders within the link", () => {
		const doc = "[![badge](pic.png)](https://ci.example) [**bold** `code`](Known)\nend";
		// Marks and replacements sit in separate layers: put them in document order.
		const shown = decorate(doc, doc.length)
			.sort((a, b) => a.from - b.from || Number(!!a.widget) - Number(!!b.widget))
			.map((d) => [doc.slice(d.from, d.to), d.widget ?? d.mark]);
		expect(shown).toEqual([
			["[", "hidden"],
			["![badge](pic.png)", "cm-underline"],
			["![badge](pic.png)", "ImageWidget"],
			["](https://ci.example)", "hidden"],
			["[", "hidden"],
			["**bold** `code`", "cm-underline"],
			["**", "hidden"],
			["**", "hidden"],
			["`", "hidden"],
			["`", "hidden"],
			["](Known)", "hidden"],
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
