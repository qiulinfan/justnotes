import MarkdownIt from "markdown-it";
import type { App } from "./app";
import { Component } from "./events";

export interface MarkdownPostProcessorContext {
	docId: string;
	sourcePath: string;
	frontmatter: any;
	addChild(child: Component): void;
	getSectionInfo(el: HTMLElement): { text: string; lineStart: number; lineEnd: number } | null;
}

type PostProcessor = ((el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void) & { sortOrder?: number };
type CodeBlockProcessor = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void;

const postProcessors: PostProcessor[] = [];
const codeBlockProcessors = new Map<string, CodeBlockProcessor>();

export const MarkdownPreviewRenderer = {
	registerPostProcessor(p: PostProcessor, sortOrder?: number) {
		if (sortOrder !== undefined) p.sortOrder = sortOrder;
		postProcessors.push(p);
		postProcessors.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	},
	unregisterPostProcessor(p: PostProcessor) {
		postProcessors.remove(p);
	},
	registerCodeBlockPostProcessor(language: string, p: CodeBlockProcessor) {
		codeBlockProcessors.set(language, p);
	},
	unregisterCodeBlockPostProcessor(language: string) {
		codeBlockProcessors.delete(language);
	},
	createCodeBlockPostProcessor(language: string, handler: CodeBlockProcessor) {
		return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			for (const code of el.findAll(`pre > code.language-${language}`)) {
				const pre = code.parentElement!;
				const div = createDiv(`block-language-${language}`);
				pre.replaceWith(div);
				handler(code.textContent ?? "", div, ctx);
			}
		};
	},
};

const md = new MarkdownIt({ html: true, linkify: true, breaks: true });

// Obsidian syntax markdown-it does not know: wikilinks, embeds and math.
md.inline.ruler.before("link", "wikilink", (state, silent) => {
	const src = state.src.slice(state.pos);
	const m = /^(!?)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/.exec(src);
	if (!m) return false;
	if (!silent) {
		const token = state.push("wikilink", "", 0);
		token.meta = { embed: !!m[1], target: m[2], display: m[3] };
	}
	state.pos += m[0].length;
	return true;
});
md.renderer.rules.wikilink = (tokens, idx) => {
	const { embed, target, display } = tokens[idx].meta as { embed: boolean; target: string; display?: string };
	const text = md.utils.escapeHtml(display ?? target);
	const href = md.utils.escapeHtml(target);
	return embed
		? `<span class="internal-embed" src="${href}">${text}</span>`
		: `<a class="internal-link" data-href="${href}" href="${href}">${text}</a>`;
};
md.inline.ruler.after("escape", "math_inline", (state, silent) => {
	if (state.src[state.pos] !== "$" || state.src[state.pos + 1] === "$") return false;
	const end = state.src.indexOf("$", state.pos + 1);
	if (end < 0 || end === state.pos + 1) return false;
	if (!silent) state.push("math_inline", "", 0).content = state.src.slice(state.pos + 1, end);
	state.pos = end + 1;
	return true;
});
md.block.ruler.before("fence", "math_block", (state, start, end, silent) => {
	const line = state.src.slice(state.bMarks[start] + state.tShift[start], state.eMarks[start]);
	if (!line.startsWith("$$")) return false;
	let content = line.slice(2);
	let next = start;
	if (content.trimEnd().endsWith("$$") && content.trim().length > 2) content = content.trimEnd().slice(0, -2);
	else {
		const lines: string[] = [content];
		for (next = start + 1; next < end; next++) {
			const l = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
			if (l.trimEnd().endsWith("$$")) {
				lines.push(l.trimEnd().slice(0, -2));
				break;
			}
			lines.push(l);
		}
		content = lines.join("\n");
	}
	if (silent) return true;
	state.push("math_block", "", 0).content = content;
	state.line = next + 1;
	return true;
});
md.renderer.rules.math_inline = (tokens, idx) => `<span class="math math-inline" data-tex="${md.utils.escapeHtml(tokens[idx].content)}"></span>`;
md.renderer.rules.math_block = (tokens, idx) => `<div class="math math-block" data-tex="${md.utils.escapeHtml(tokens[idx].content)}"></div>`;

// The libraries Obsidian exposes load on first use from dist/lib (build.ts),
// each once, and end up as the same window globals Obsidian sets.
const libUrl = (file: string) => new URL(`lib/${file}`, document.baseURI).href;

function loadScript(src: string) {
	return new Promise<void>((resolve, reject) => {
		const script = document.head.createEl("script", { attr: { src } });
		script.addEventListener("load", () => resolve());
		script.addEventListener("error", () => reject(new Error(`${src} failed to load`)));
	});
}

// MathJax 3.2 with CHTML output, like Obsidian's: plugins call tex2chtml,
// chtmlStylesheet, startup.output and the MathJax._ internals of the full
// combined build. Glyph CSS accumulates in one stylesheet that
// finishRenderMath refreshes, so the woff fonts must sit at fontURL. As in
// Obsidian there is no menu and no assistive MathML, and the safe extension
// filters \href protocols and styles. latex-live passes config.options to its
// own MathDocument, so it may only hold options the build knows.
let mathJax: Promise<void> | null = null;

export function loadMathJax() {
	mathJax ??= new Promise<void>((resolve, reject) => {
		const w = window as any;
		w.MathJax = {
			tex: { inlineMath: [["$", "$"], ["\\(", "\\)"]], displayMath: [["$$", "$$"], ["\\[", "\\]"]], processEscapes: true },
			chtml: { fontURL: libUrl("mathjax/output/chtml/fonts/woff-v2") },
			// The menu component applies its own assistiveMml setting even when disabled.
			options: { enableMenu: false, enableAssistiveMml: false, menuOptions: { settings: { assistiveMml: false } } },
			loader: { load: ["ui/safe"] },
			startup: { typeset: false },
		};
		loadScript(libUrl("mathjax/tex-chtml-full.js")).then(
			() =>
				w.MathJax.startup.promise.then(() => {
					// In the head from the start, so plugin stylesheets added later
					// keep their precedence over MathJax's rules.
					document.head.appendChild(w.MathJax.chtmlStylesheet());
					resolve();
				}, reject),
			reject,
		);
	});
	return mathJax;
}

let finishQueued = false;

export function renderMath(source: string, display: boolean): HTMLElement {
	const mj = (window as any).MathJax;
	if (typeof mj?.tex2chtml !== "function") return createSpan({ cls: "math", text: display ? `$$${source}$$` : `$${source}$` });
	let el: HTMLElement;
	try {
		el = mj.tex2chtml(source, { display });
	} catch (err) {
		return createSpan({ cls: "math-error", text: String(err) });
	}
	// Callers that never call finishRenderMath (Live Preview widgets) still get
	// their glyph CSS once the current task ends.
	if (!finishQueued) {
		finishQueued = true;
		queueMicrotask(() => {
			finishQueued = false;
			finishRenderMath();
		});
	}
	return el;
}

// Adds the CSS for glyphs rendered since the last call. chtmlStylesheet()
// returns the same element each time; it moves into the head only when it is
// not there yet.
export async function finishRenderMath() {
	const mj = (window as any).MathJax;
	if (typeof mj?.chtmlStylesheet !== "function") return;
	const sheet: HTMLStyleElement = mj.chtmlStylesheet();
	if (!sheet.isConnected) document.head.appendChild(sheet);
}

let prism: Promise<any> | null = null;

export function loadPrism() {
	prism ??= loadScript(libUrl("prism/prism.js")).then(() => (window as any).Prism);
	return prism;
}

// pdf.js 5 ships only as ES modules; the page imports them from file:// (web
// security is off). Its worker cannot reach the /lib/ redirect, so getDocument
// fills in and rewrites the asset folders as absolute URLs.
let pdfjs: Promise<any> | null = null;
const PDF_ASSETS = { cMapUrl: "cmaps/", standardFontDataUrl: "standard_fonts/", wasmUrl: "wasm/", iccUrl: "iccs/" };

export function loadPdfJs() {
	pdfjs ??= (async () => {
		const base = libUrl("pdfjs/");
		const lib = await import(`${base}pdf.min.mjs`);
		lib.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
		const withAssets = (src: any) => {
			const params = typeof src === "string" || src instanceof URL ? { url: src } : ArrayBuffer.isView(src) ? { data: src } : { ...src };
			for (const [key, dir] of Object.entries(PDF_ASSETS)) {
				const value = params[key];
				if (typeof value !== "string") params[key] = base + dir;
				else if (value.startsWith("/lib/pdfjs/")) params[key] = base + value.slice("/lib/pdfjs/".length);
			}
			return params;
		};
		const pdfjsLib = { ...lib, getDocument: (src: any) => lib.getDocument(withAssets(src)) };
		(window as any).pdfjsLib = pdfjsLib;
		return pdfjsLib;
	})();
	return pdfjs;
}

let mermaid: Promise<any> | null = null;

export function loadMermaid() {
	mermaid ??= loadScript(libUrl("mermaid/mermaid.min.js")).then(() => {
		const m = (window as any).mermaid;
		m.initialize({ startOnLoad: false });
		return m;
	});
	return mermaid;
}

export class MarkdownRenderChild extends Component {
	containerEl: HTMLElement;

	constructor(containerEl: HTMLElement) {
		super();
		this.containerEl = containerEl;
	}
}

let appRef: App | null = null;
export function setMarkdownApp(app: App) {
	appRef = app;
}

export class MarkdownRenderer extends MarkdownRenderChild {
	app: App;

	constructor(app: App, containerEl: HTMLElement) {
		super(containerEl);
		this.app = app;
	}

	static async render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component) {
		el.addClass("markdown-rendered");
		const frontmatterless = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/, "");
		const tpl = document.createElement("template");
		tpl.innerHTML = md.render(frontmatterless);
		el.appendChild(tpl.content);
		for (const m of el.findAll(".math[data-tex]")) {
			const display = m.hasClass("math-block");
			const wrap = createEl(display ? "div" : "span", { cls: ["math", display ? "math-block" : "math-inline", "is-loaded"] });
			wrap.appendChild(renderMath(m.getAttribute("data-tex") ?? "", display));
			m.replaceWith(wrap);
		}
		await finishRenderMath();
		const ctx: MarkdownPostProcessorContext = {
			docId: Math.random().toString(36).slice(2),
			sourcePath,
			frontmatter: app.metadataCache.getCache(sourcePath)?.frontmatter,
			addChild: (child) => component.addChild(child),
			getSectionInfo: () => ({ text: markdown, lineStart: 0, lineEnd: markdown.split("\n").length - 1 }),
		};
		for (const code of el.findAll("pre > code")) {
			const lang = [...code.classList].find((c) => c.startsWith("language-"))?.slice(9);
			const processor = lang ? codeBlockProcessors.get(lang) : undefined;
			if (!processor) continue;
			const div = createDiv(`block-language-${lang}`);
			code.parentElement!.replaceWith(div);
			await processor(code.textContent ?? "", div, ctx);
		}
		for (const p of postProcessors) await p(el, ctx);
	}

	static renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component) {
		return MarkdownRenderer.render(appRef!, markdown, el, sourcePath, component);
	}
}
