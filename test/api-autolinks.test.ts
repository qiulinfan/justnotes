import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { type Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { obsidianMarkdown } from "../src/api/editor-extensions";
import { clickableTokenAt, type LivePreviewHost, livePreview } from "../src/api/live-preview";

const host = {
	app: {
		vault: { getConfig: () => undefined, on: () => ({}), offref() {} },
		metadataCache: { getFirstLinkpathDest: () => null, getCache: () => null },
	},
	sourcePath: () => "note.md",
	resolveImage: () => null,
} as unknown as LivePreviewHost;

const links = ["<review@example.com>", "<www.team@example.com>", "www.example.com", "review2@example.com", "<https://example.com/angle>", "https://example.com/bare"];
const doc = `${links.join(" ")}\n\n[ref]: notes/target.md\n\nend`;
const state = EditorState.create({
	doc,
	selection: { anchor: doc.length },
	extensions: [markdown({ base: markdownLanguage, extensions: obsidianMarkdown }), livePreview(host)],
});

// MarkdownView.onLinkClick, the editor menu's Open link and the follow-link
// commands hand a link to window.open only when it has a scheme; a bare
// address opened a new note named after it instead.
describe("Live Preview autolinks", () => {
	test("email and www. addresses carry an https: or mailto: data-href", () => {
		const hrefs: Record<string, string> = {};
		for (const set of state.facet(EditorView.decorations) as DecorationSet[]) {
			set.between(0, state.doc.length, (from, to, value: Decoration) => {
				const href = value.spec.attributes?.["data-href"];
				if (href) hrefs[state.sliceDoc(from, to)] = href;
			});
		}
		expect(hrefs).toEqual({
			"review@example.com": "mailto:review@example.com",
			"www.team@example.com": "mailto:www.team@example.com",
			"www.example.com": "https://www.example.com",
			"review2@example.com": "mailto:review2@example.com",
			"https://example.com/angle": "https://example.com/angle",
			"https://example.com/bare": "https://example.com/bare",
			// A reference definition's relative destination still opens the note.
			"notes/target.md": "notes/target.md",
		});
	});

	test("the link under the cursor opens the same address", () => {
		const at = (text: string) => clickableTokenAt(state, doc.indexOf(text) + 2)?.text;
		expect(at("review@")).toBe("mailto:review@example.com");
		expect(at("www.example")).toBe("https://www.example.com");
		expect(at("review2@")).toBe("mailto:review2@example.com");
		expect(at("https://example.com/angle")).toBe("https://example.com/angle");
	});
});
