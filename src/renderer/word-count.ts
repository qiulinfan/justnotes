import type { CorePluginHost } from "../api/internal-plugins";
import type { App } from "../api/app";
import { MarkdownView } from "../api/markdown-view";
import { debounce } from "../api/util";

// Chinese and Japanese characters count one word each; anything else counts
// runs of letters and digits between spaces, so a lone dash is no word.
// Characters are every character but line breaks.
export function countWords(text: string) {
	let words = 0;
	for (const m of text.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)) {
		if (/[\p{L}\p{N}]/u.test(m[0])) words++;
	}
	let characters = 0;
	for (const ch of text) if (ch !== "\n" && ch !== "\r") characters++;
	return { words, characters };
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

// The status bar's count for the active note, or for its selection while
// one is made, as Obsidian's Word count shows it.
export function installWordCount(app: App, host: CorePluginHost) {
	const el = host.addStatusBarItem("plugin-word-count");
	const update = debounce(
		() => {
			const view = app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) {
				el.empty();
				return;
			}
			const selection = view.getMode() === "source" ? view.editor.getSelection() : "";
			const { words, characters } = countWords(selection || view.editor.getValue());
			el.setText(`${plural(words, "word")} ${plural(characters, "character")}`);
		},
		200,
		true,
	);
	for (const name of ["active-leaf-change", "file-open", "editor-change", "layout-change"]) host.registerEvent(app.workspace.on(name, update));
	const onSelection = () => update();
	host.registerDomEvent(document, "selectionchange", onSelection);
	host.registerEvent(app.workspace.on("window-open", (_win: unknown, win: Window) => host.registerDomEvent(win.document, "selectionchange", onSelection)));
	host.register(() => update.cancel());
	update();
}
