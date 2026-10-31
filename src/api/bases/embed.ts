// Bases inside notes: ```base blocks and ![[file.base]] / ![[file.base#View]]
// embeds. In both, `this` is the note that contains them.
import type { App } from "../app";
import type { MarkdownPostProcessorContext } from "../markdown";
import { MarkdownRenderChild } from "../markdown";
import { parseLinktext } from "../metadata-utils";
import type { TAbstractFile, TFile } from "../vault";
import { QueryController } from "./controller";

// A ```base fence line. Group 1 holds what comes before the fence inside list
// items and block quotes: indentation, list markers and ">".
const FENCE = /^((?:[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])[ \t]))*[ \t]*)(`{3,}|~{3,})[ \t]*base[ \t]*$/;

// A block line as the renderer passes it, without its container's prefix.
// Markdown removes at most the prefix's indentation, so a line indented less,
// or an empty quoted line such as ">", loses all of it.
function unprefix(line: string, prefix: string) {
	if (line.startsWith(prefix)) return line.slice(prefix.length);
	let i = 0;
	for (let j = 0; i < line.length && j < prefix.length; j++) {
		if (line[i] === prefix[j]) i++;
		else if (prefix[j] !== " " && prefix[j] !== "\t") break;
	}
	return line.slice(i);
}

// Replace the content of the one ```base block in `text` whose source, as the
// renderer passes it to the block's processor, reads `before`. When no block
// or several match, nothing is written.
export function replaceBaseBlock(text: string, before: string, after: string): string | null {
	const lines = text.split("\n");
	const bare = lines.map((line) => line.replace(/\r$/, ""));
	const want = before.replace(/\r\n/g, "\n").trimEnd();
	const found: { start: number; end: number; prefix: string }[] = [];
	for (let i = 0; i < bare.length; i++) {
		const m = FENCE.exec(bare[i]);
		if (!m) continue;
		// The block's lines line up under the fence, list markers included.
		const prefix = m[1].replace(/[-+*]|\d+[.)]/g, (marker) => " ".repeat(marker.length));
		const close = new RegExp(`^ {0,3}${m[2][0]}{${m[2].length},}[ \\t]*$`);
		let end = i + 1;
		while (end < bare.length && !close.test(unprefix(bare[end], prefix))) end++;
		const body = bare.slice(i + 1, end).map((line) => unprefix(line, prefix));
		if (body.join("\n").trimEnd() === want) found.push({ start: i + 1, end, prefix });
		i = end;
	}
	if (found.length !== 1) return null;
	const { start, end, prefix } = found[0];
	const eol = lines[start - 1].endsWith("\r") ? "\r" : "";
	const body = after
		.trimEnd()
		.split("\n")
		.map((line) => (line ? prefix + line : prefix.trimEnd()) + eol);
	return [...lines.slice(0, start), ...body, ...lines.slice(end)].join("\n");
}

export function renderBaseBlock(app: App, source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
	el.addClass("bases-embed");
	let written = source;
	const child = new MarkdownRenderChild(el);
	child.addChild(
		new QueryController(app, el.createDiv(), {
			text: source,
			file: null,
			sourcePath: ctx.sourcePath,
			thisFile: () => app.vault.getFileByPath(ctx.sourcePath),
			save: async (text) => {
				const note = app.vault.getFileByPath(ctx.sourcePath);
				if (!note) return;
				await app.vault.process(note, (data) => {
					const next = replaceBaseBlock(data, written, text);
					if (next === null) return data;
					written = text;
					return next;
				});
			},
		}),
	);
	ctx.addChild(child);
}

class BaseFileEmbed extends MarkdownRenderChild {
	#app: App;
	#file: TFile;
	#viewName: string;
	#sourcePath: string;
	#controller: QueryController | null = null;

	constructor(app: App, el: HTMLElement, file: TFile, viewName: string, sourcePath: string) {
		super(el);
		this.#app = app;
		this.#file = file;
		this.#viewName = viewName;
		this.#sourcePath = sourcePath;
	}

	onload() {
		const app = this.#app;
		const file = this.#file;
		this.registerEvent(
			app.vault.on("modify", async (f: TAbstractFile) => {
				if (f === file && this.#controller) this.#controller.setSource(await app.vault.cachedRead(file));
			}),
		);
		app.vault.cachedRead(file).then((text) => {
			if (!this._loaded) return;
			this.#controller = this.addChild(
				new QueryController(app, this.containerEl.createDiv(), {
					text,
					file,
					sourcePath: this.#sourcePath,
					thisFile: () => app.vault.getFileByPath(this.#sourcePath),
					viewName: this.#viewName || null,
					save: (next) => app.vault.modify(file, next),
				}),
			);
		});
	}
}

// Mount the .base files that rendered embeds point to.
export function renderBaseEmbeds(app: App, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
	for (const span of el.findAll(".internal-embed[src]")) {
		if (span.hasClass("bases-embed")) continue;
		const { path, subpath } = parseLinktext(span.getAttribute("src") ?? "");
		const file = app.metadataCache.getFirstLinkpathDest(path, ctx.sourcePath);
		if (file?.extension !== "base") continue;
		span.empty();
		span.addClass("bases-embed", "is-loaded");
		ctx.addChild(new BaseFileEmbed(app, span, file, subpath.replace(/^#/, ""), ctx.sourcePath));
	}
}
