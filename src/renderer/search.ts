import { debounce } from "../api/util";
import type { TFile } from "../api/vault";
import { ItemView } from "../api/view";
import type { WorkspaceLeaf } from "../api/workspace";

const MAX_FILES = 200;
const MAX_MATCHES_PER_FILE = 20;

// Builds a line matcher: `/re/` is a regex, anything else a plain string,
// case-sensitive only when it contains an uppercase letter.
function compile(query: string): RegExp | null {
	const re = /^\/(.+)\/([a-z]*)$/.exec(query);
	try {
		if (re) return new RegExp(re[1], re[2].includes("g") ? re[2] : `${re[2]}g`);
		const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(escaped, /[A-Z]/.test(query) ? "g" : "gi");
	} catch {
		return null;
	}
}

// Full-text search that reads the Markdown files directly; no index.
export class SearchView extends ItemView {
	inputEl!: HTMLInputElement;
	#summaryEl!: HTMLElement;
	#resultsEl!: HTMLElement;
	#run = debounce(() => this.#search(), 200, true);
	#generation = 0;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.icon = "search";
	}

	getViewType() {
		return "search";
	}

	getDisplayText() {
		return "Search";
	}

	async onOpen() {
		this.headerEl.hide();
		const row = this.contentEl.createDiv("search-input-row");
		this.inputEl = row.createEl("input", { type: "search", placeholder: "Search files... (/regex/ works)" });
		this.inputEl.addEventListener("input", () => this.#run());
		this.#summaryEl = this.contentEl.createDiv("search-summary");
		this.#resultsEl = this.contentEl.createDiv("search-results");
	}

	async #search() {
		const generation = ++this.#generation;
		const query = this.inputEl.value.trim();
		this.#resultsEl.empty();
		this.#summaryEl.empty();
		if (!query) return;
		const re = compile(query);
		if (!re) {
			this.#summaryEl.setText("Invalid regular expression");
			return;
		}
		let files = 0;
		let matches = 0;
		const all = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime);
		for (const file of all) {
			const text = await this.app.vault.cachedRead(file);
			if (generation !== this.#generation) return;
			const hits = this.#matchFile(file, text, re);
			if (hits === 0) continue;
			files++;
			matches += hits;
			if (files >= MAX_FILES) break;
		}
		this.#summaryEl.setText(`${matches} matches in ${files} files${files >= MAX_FILES ? " (showing the first 200 files)" : ""}`);
	}

	#matchFile(file: TFile, text: string, re: RegExp) {
		const lines = text.split("\n");
		let group: HTMLElement | null = null;
		let count = 0;
		const nameHit = file.basename.search(new RegExp(re.source, re.flags.replace("g", ""))) >= 0;
		for (let line = 0; line < lines.length && count < MAX_MATCHES_PER_FILE; line++) {
			re.lastIndex = 0;
			const m = re.exec(lines[line]);
			if (!m || m[0].length === 0) continue;
			group ??= this.#fileGroup(file);
			count++;
			const el = group.createDiv("search-result-match");
			const start = Math.max(0, m.index - 30);
			el.appendText((start > 0 ? "…" : "") + lines[line].slice(start, m.index));
			el.createEl("mark", { text: m[0] });
			el.appendText(lines[line].slice(m.index + m[0].length, m.index + m[0].length + 80));
			const pos = { line, ch: m.index };
			el.addEventListener("click", () => this.#open(file, pos));
		}
		if (!group && nameHit) this.#fileGroup(file);
		return count || (nameHit ? 1 : 0);
	}

	#fileGroup(file: TFile) {
		const group = this.#resultsEl.createDiv("search-result");
		const title = group.createDiv({ cls: "search-result-file-title", text: file.path.replace(/\.md$/, "") });
		title.addEventListener("click", () => this.#open(file, null));
		return group;
	}

	async #open(file: TFile, pos: { line: number; ch: number } | null) {
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { active: true });
		const editor = (leaf.view as any).editor;
		if (pos && editor) {
			editor.setCursor(pos);
			editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}
}
