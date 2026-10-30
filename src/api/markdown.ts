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

// MathJax 3 with SVG output and a local font cache, so every rendered formula
// is self-contained and finishRenderMath has nothing to flush.
let mathJaxReady: Promise<void> | null = null;

export function loadMathJax() {
	mathJaxReady ??= new Promise<void>((resolve, reject) => {
		(window as any).MathJax = {
			tex: { inlineMath: [["$", "$"]], displayMath: [["$$", "$$"]], processEscapes: true },
			svg: { fontCache: "local" },
			startup: { typeset: false, ready: () => (window as any).MathJax.startup.defaultReady() },
		};
		const script = document.head.createEl("script", { attr: { src: "mathjax/tex-svg-full.js" } });
		script.addEventListener("error", () => reject(new Error("MathJax failed to load")));
		script.addEventListener("load", () =>
			(window as any).MathJax.startup.promise.then(() => {
				// Hides the assistive MathML copy that sits beside each SVG.
				document.head.appendChild((window as any).MathJax.svgStylesheet());
				resolve();
			}, reject),
		);
	});
	return mathJaxReady;
}

export function renderMath(source: string, display: boolean): HTMLElement {
	const mj = (window as any).MathJax;
	if (mj?.tex2svg) {
		try {
			return mj.tex2svg(source, { display });
		} catch (err) {
			return createSpan({ cls: "math-error", text: String(err) });
		}
	}
	return createSpan({ cls: "math", text: display ? `$$${source}$$` : `$${source}$` });
}

export async function finishRenderMath() {}
export async function loadPrism() {
	return (window as any).Prism;
}
export async function loadPdfJs() {
	return (window as any).pdfjsLib;
}
export async function loadMermaid() {
	return (window as any).mermaid;
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
			const wrap = createEl(display ? "div" : "span", { cls: ["math", display ? "math-block" : "math-inline"] });
			wrap.appendChild(renderMath(m.getAttribute("data-tex") ?? "", display));
			m.replaceWith(wrap);
		}
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
