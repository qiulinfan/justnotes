// Bases inside notes: ```base blocks and ![[file.base]] / ![[file.base#View]]
// embeds. In both, `this` is the note that contains them.
import type { App } from "../app";
import type { MarkdownPostProcessorContext } from "../markdown";
import { MarkdownRenderChild } from "../markdown";
import { parseLinktext } from "../metadata-utils";
import type { TAbstractFile, TFile } from "../vault";
import { QueryController } from "./controller";

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*base[ \t]*\r?\n/gm;

// Replace the content of the one ```base block in `text` that reads `before`;
// when no block or several match, nothing is written.
export function replaceBaseBlock(text: string, before: string, after: string): string | null {
	const matches: [number, number][] = [];
	for (const m of text.matchAll(FENCE)) {
		const start = m.index! + m[0].length;
		const close = new RegExp(`^${m[1]}${m[2][0]}{${m[2].length},}[ \\t]*$`, "m");
		const rest = text.slice(start);
		const end = close.exec(rest);
		const body = end ? rest.slice(0, end.index) : rest;
		if (body.trimEnd() === before.trimEnd()) matches.push([start, start + body.length]);
	}
	if (matches.length !== 1) return null;
	const [start, end] = matches[0];
	return `${text.slice(0, start)}${after.trimEnd()}\n${text.slice(end)}`;
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
