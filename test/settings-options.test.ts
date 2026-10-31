import { describe, expect, test } from "bun:test";
import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import type { App } from "../src/api/app";
import { type EditorOptions, editorOptionExtensions } from "../src/api/editor-options";
import { attachmentLocation, EditorTab, fontFamilyList } from "../src/api/setting-options";
import { searchDefinitions } from "../src/api/ui/setting-definitions";

const ALL_ON: EditorOptions = { lineNumbers: true, autoPairBrackets: true, autoPairMarkdown: true, smartLists: true, spellcheck: true, rightToLeft: false, indentGuides: true };

// Types `text` over the selection through the editor's input handlers, as
// CodeMirror does for a keypress; falls back to plain insertion.
function typeOver(doc: string, from: number, to: number, text: string, options: EditorOptions) {
	let state = EditorState.create({ doc, selection: EditorSelection.single(from, to), extensions: editorOptionExtensions(options) });
	const view = {
		get state() {
			return state;
		},
		dispatch: (...specs: TransactionSpec[]) => {
			state = state.update(...specs).state;
		},
	} as unknown as EditorView;
	const handled = state.facet(EditorView.inputHandler).some((h) => h(view, from, to, text, () => state.update({ changes: { from, to, insert: text } })));
	if (!handled) state = state.update({ changes: { from, to, insert: text } }).state;
	return { text: state.doc.toString(), selected: state.sliceDoc(state.selection.main.from, state.selection.main.to) };
}

describe("Editor options", () => {
	test("Auto-pair Markdown syntax wraps the selection in a typed mark, and only when on", () => {
		expect(typeOver("a word here", 2, 6, "*", ALL_ON)).toEqual({ text: "a *word* here", selected: "word" });
		expect(typeOver("a word here", 2, 6, "*", { ...ALL_ON, autoPairMarkdown: false }).text).toBe("a * here");
		// Without a selection the mark is typed as usual.
		expect(typeOver("ab", 1, 1, "*", ALL_ON).text).toBe("a*b");
	});

	test("Smart lists decide whether Enter continues list markup", () => {
		const enterBindings = (options: EditorOptions) =>
			EditorState.create({ extensions: editorOptionExtensions(options) })
				.facet(keymap)
				.flat()
				.filter((b) => b.key === "Enter")
				.map((b) => b.run);
		expect(enterBindings(ALL_ON)).toContain(insertNewlineContinueMarkup);
		expect(enterBindings({ ...ALL_ON, smartLists: false })).not.toContain(insertNewlineContinueMarkup);
	});

	test("Spellcheck and right-to-left set the editable content's attributes", () => {
		const attrs = (options: EditorOptions) => Object.assign({}, ...EditorState.create({ extensions: editorOptionExtensions(options) }).facet(EditorView.contentAttributes).filter((a) => typeof a === "object"));
		expect(attrs(ALL_ON)).toMatchObject({ spellcheck: "true", dir: "ltr" });
		expect(attrs({ ...ALL_ON, spellcheck: false, rightToLeft: true })).toMatchObject({ spellcheck: "false", dir: "rtl" });
	});
});

describe("Settings pages", () => {
	test("the attachment location is read from attachmentFolderPath as Obsidian encodes it", () => {
		expect(attachmentLocation(undefined)).toEqual({ location: "root", folder: "" });
		expect(attachmentLocation("/")).toEqual({ location: "root", folder: "" });
		expect(attachmentLocation("./")).toEqual({ location: "current", folder: "" });
		expect(attachmentLocation("./附件")).toEqual({ location: "subfolder", folder: "附件" });
		expect(attachmentLocation("Assets/Attachments")).toEqual({ location: "folder", folder: "Assets/Attachments" });
	});

	test("font settings become a font-family list with names quoted and generic families bare", () => {
		expect(fontFamilyList("Inter, Source Han Sans, sans-serif")).toBe('"Inter", "Source Han Sans", sans-serif');
		expect(fontFamilyList("")).toBe("");
		expect(fontFamilyList(undefined)).toBe("");
	});

	test("settings search finds the Editor page's options, the justnotes section included", () => {
		const app = { vault: { getConfig: () => undefined } } as unknown as App;
		const items = EditorTab.prototype.getSettingDefinitions.call({ app } as EditorTab);
		expect(searchDefinitions(items, "line numbers").map((m) => m.name)).toEqual(["Show line numbers"]);
		expect(searchDefinitions(items, "tab size").map((m) => m.name)).toEqual(["Indent visual width"]);
		expect(searchDefinitions(items, "selection scroll").map((m) => m.name)).toEqual(["Selection scroll speed"]);
	});
});
