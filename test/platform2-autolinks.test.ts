import { describe, expect, test } from "bun:test";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { type Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { obsidianMarkdown } from "../src/api/editor-extensions";
import { clickableTokenAt, type LivePreviewHost, livePreview } from "../src/api/live-preview";

const host = {
	app: {
		loadLocalStorage: () => null,
		vault: { getConfig: () => undefined, on: () => ({}), offref() {} },
		metadataCache: { getFirstLinkpathDest: () => null, getCache: () => null },
	},
	sourcePath: () => "note.md",
	resolveImage: () => null,
} as unknown as LivePreviewHost;

// "www.example.com:" reads like a URL scheme, so a bare www. address with a
// port went to the system as "www.example.com:8080/x", which opens nothing.
describe("Live Preview: a bare www. address with a port", () => {
	const doc = "Port www.example.com:8080/x here.\n\nend";
	const state = EditorState.create({
		doc,
		selection: { anchor: doc.length },
		extensions: [markdown({ base: markdownLanguage, extensions: obsidianMarkdown }), livePreview(host)],
	});

	test("opens as https:, from a click and from the link under the cursor", () => {
		const hrefs: string[] = [];
		for (const set of state.facet(EditorView.decorations) as DecorationSet[]) {
			set.between(0, state.doc.length, (_from, _to, value: Decoration) => {
				const href = value.spec.attributes?.["data-href"];
				if (href) hrefs.push(href);
			});
		}
		expect(hrefs).toEqual(["https://www.example.com:8080/x"]);
		expect(clickableTokenAt(state, doc.indexOf("example"))?.text).toBe("https://www.example.com:8080/x");
	});
});
