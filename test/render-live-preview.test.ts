import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { type Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { obsidianMarkdown } from "../src/api/editor-extensions";
import { editorLivePreviewField, type LivePreviewHost, livePreview } from "../src/api/live-preview";
import { MarkdownPreviewRenderer, resolveHtmlSrc } from "../src/api/markdown";

const files: Record<string, string> = { Note: "Note.md", "pic.png": "pic.png", "doc.pdf": "doc.pdf" };
const host = {
	app: {
		vault: { getConfig: () => undefined },
		metadataCache: { getFirstLinkpathDest: (path: string) => (files[path] ? { path: files[path] } : null), getCache: () => null },
	},
	sourcePath: () => "note.md",
	resolveImage: (link: string) => (files[link] && link.endsWith(".png") ? `app://vault/${link}` : null),
} as unknown as LivePreviewHost;

interface Shown {
	text: string;
	widget?: string;
	block?: boolean;
	cls?: string;
}

// What Live Preview shows over `doc` with the cursor at `cursor`: widgets
// with the text they replace, and marks with the classes their DOM gets.
function shown(doc: string, cursor = doc.length, ...extensions: Extension[]): Shown[] {
	const state = EditorState.create({
		doc,
		selection: { anchor: cursor },
		extensions: [...extensions, markdown({ base: markdownLanguage, extensions: obsidianMarkdown }), livePreview(host)],
	});
	ensureSyntaxTree(state, state.doc.length, 5000);
	const out: (Shown & { from: number })[] = [];
	for (const set of state.facet(EditorView.decorations) as DecorationSet[]) {
		set.between(0, state.doc.length, (from, to, value: Decoration) => {
			const { spec } = value;
			const text = doc.slice(from, to);
			if (spec.widget) out.push({ from, text, widget: spec.widget.constructor.name, block: !!spec.block });
			else if (spec.class && from < to) out.push({ from, text, cls: [spec.class, spec.attributes?.class].filter(Boolean).join(" ") });
		});
	}
	// Overlapping decorations sit in separate layers; report them in document order.
	return out.sort((a, b) => a.from - b.from).map(({ from: _, ...rest }) => rest);
}

describe("embeds", () => {
	const doc = "![[Note]]\n\n- item ![[Note#Part]] here\n\n![[pic.png]]\n\n![[gone.png]]\n\n![](doc.pdf)\n\nend";
	const embeds = (cursor?: number) => shown(doc, cursor).filter((s) => s.widget === "EmbedWidget" || s.widget === "ImageWidget");

	// Notes, PDFs, bases and missing files render through the renderer; an
	// embed alone on its line takes the whole line as a block.
	test("found images stay images; other embeds render as blocks, or inside a list line", () => {
		expect(embeds()).toEqual([
			{ text: "![[Note]]", widget: "EmbedWidget", block: true },
			{ text: "![[Note#Part]]", widget: "EmbedWidget", block: false },
			{ text: "![[pic.png]]", widget: "ImageWidget", block: false },
			{ text: "![[gone.png]]", widget: "EmbedWidget", block: true },
			{ text: "![](doc.pdf)", widget: "EmbedWidget", block: true },
		]);
	});

	test("the cursor on an embed's line shows its source", () => {
		expect(embeds(1).map((s) => s.text)).not.toContain("![[Note]]");
	});
});

// Source mode (editorLivePreviewField off) keeps every widget away.
describe("source mode", () => {
	test("renders no embed, code-block processor, table or math", () => {
		const processor = () => {};
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor("source-lang", processor);
		try {
			const doc = "![[Note]]\n\n```source-lang\nx\n```\n\n| a |\n| - |\n| 1 |\n\n$$\nx\n$$\n\nend";
			expect(shown(doc).filter((s) => s.widget && s.widget !== "hidden").map((s) => s.widget)).toEqual([
				"EmbedWidget",
				"CodeBlockWidget",
				"RenderedBlockWidget",
				"MathWidget",
			]);
			expect(shown(doc, doc.length, editorLivePreviewField.init(() => false)).filter((s) => s.widget)).toEqual([]);
		} finally {
			MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor("source-lang", processor);
		}
	});
});

// Raw HTML images in notes written in Typora: the reading view and Live
// Preview both find them in the vault this way.
describe("resolveHtmlSrc", () => {
	const vault = new Set(["notes/Assets/a b.png", "shot.png"]);
	const resolve = (src: string) => resolveHtmlSrc(src, (path) => (vault.has(path) ? path : vault.has(`notes/${path}`) ? `notes/${path}` : null));

	test("relative paths with backslashes, ./ and %-escapes find the file", () => {
		expect(resolve("Assets\\a b.png")).toBe("notes/Assets/a b.png");
		expect(resolve("./Assets/a%20b.png")).toBe("notes/Assets/a b.png");
	});

	test("an absolute path from another machine finds the file by its name", () => {
		expect(resolve("/Users/someone/vault/shot.png")).toBe("shot.png");
		expect(resolve("C:\\Users\\someone\\Pictures\\shot.png")).toBe("shot.png");
	});

	test("URLs and anchors are not vault paths", () => {
		expect(resolve("https://example.com/shot.png")).toBeNull();
		expect(resolve("//cdn.example.com/shot.png")).toBeNull();
		expect(resolve("#shot.png")).toBeNull();
	});
});
