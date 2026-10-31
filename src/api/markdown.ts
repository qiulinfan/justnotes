import MarkdownIt, { type Env, type StateBlock, type StateCore, type StateInline, type Token } from "markdown-it";
import type { App } from "./app";
import { Component } from "./events";
import { setIcon } from "./icons";
import { Keymap } from "./keymap";
import { getLinkpath, parseLinktext, stripHeading } from "./metadata-utils";
import { sanitizeHTML } from "./sanitize";
import { Menu } from "./ui/menu";
import { parseYaml } from "./util";
import type { TFile } from "./vault";

export interface MarkdownSectionInformation {
	text: string;
	lineStart: number;
	lineEnd: number;
}

export interface MarkdownPostProcessorContext {
	docId: string;
	sourcePath: string;
	frontmatter: any | null | undefined;
	addChild(child: Component): void;
	getSectionInfo(el: HTMLElement): MarkdownSectionInformation | null;
}

export interface MarkdownPostProcessor {
	(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<any> | void;
	sortOrder?: number;
}

type CodeBlockHandler = (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => Promise<any> | void;

const postProcessors: MarkdownPostProcessor[] = [];
const codeBlockRegistrations = new Map<string, { handler: CodeBlockHandler; postProcessor: MarkdownPostProcessor }[]>();

function removeFrom<T>(list: T[], item: T) {
	const i = list.indexOf(item);
	if (i >= 0) list.splice(i, 1);
}

const isPromise = (value: unknown): value is Promise<unknown> => typeof (value as Promise<unknown> | undefined)?.then === "function";

// ---------------------------------------------------------------------------
// Obsidian's Markdown dialect on markdown-it. Rules work on tokens; the HTML
// they produce is sanitized before it reaches the page, and placeholders
// (math, embeds) are filled in afterwards.

interface FootnoteState {
	defs: Map<string, { text: string; start: number; end: number }>;
	// Footnotes in the order of their first reference.
	notes: { label?: string; tokens?: Token[]; refs: number }[];
	byLabel: Map<string, number>;
}

interface RenderEnv extends Env {
	sourcePath: string;
	docId: string;
	// Whether a link path names an existing file; is-unresolved otherwise.
	resolve(linkpath: string): boolean;
	// Prism, once loaded, highlights fenced code; languages a code-block
	// processor replaces are left alone.
	prism?: any;
	skipHighlight?(language: string): boolean;
	frontmatter?: string;
	footnotes?: FootnoteState;
	inFootnote?: boolean;
	// First line of the section being rendered: list items carry their line
	// relative to it, as in Obsidian.
	sectionLine?: number;
}

const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
// "notes.md" is a domain name to linkify; Obsidian only links real URLs.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
// markdown-it refuses file: links; script URLs stay out (DOMPurify drops them too).
md.validateLink = (url) => {
	const u = url.trim().toLowerCase();
	if (/^(?:javascript|vbscript):/.test(u)) return false;
	return !u.startsWith("data:") || /^data:image\/(?:gif|png|jpeg|webp);/.test(u);
};

const esc = md.utils.escapeHtml;
// Renderer rules receive markdown-it's loosely typed env.
const envOf = (env: Env | undefined) => env as RenderEnv;
const SCHEME = /^[a-z][\w+.-]*:/i;
// ^id after a space, or on a line of its own at the end of a paragraph.
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;
const CALLOUT = /^\[!([^\]|]+)(?:\|([^\]]*))?\]([+-]?)[ \t]*(.*)$/;
const TAG = /^[^\s#!@$%^&*(),.?":{}|<>[\]\\`'~;=+]+/;

function decodeLink(href: string) {
	try {
		return decodeURI(href);
	} catch {
		return href;
	}
}

function lineText(state: StateBlock, line: number) {
	return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

// "Note > Heading" for [[Note#Heading]], as Obsidian displays a link without alias.
function linkDisplay(linktext: string) {
	const { path, subpath } = parseLinktext(linktext);
	return [path, ...subpath.split("#").filter(Boolean)].filter(Boolean).join(" > ");
}

function isResolved(linktext: string, env: RenderEnv) {
	const path = getLinkpath(linktext);
	return !path || env.resolve(path);
}

function internalLinkAttrs(linktext: string, env: RenderEnv) {
	const cls = isResolved(linktext, env) ? "internal-link" : "internal-link is-unresolved";
	return `data-href="${esc(linktext)}" href="${esc(linktext)}" class="${cls}" target="_blank" rel="noopener nofollow"`;
}

// An embed is a placeholder until the DOM pass resolves its target: image,
// media, PDF or a transcluded note. "|200" or "|200x100" sizes it; any other
// text is the alt text.
function embedPlaceholder(src: string, label?: string) {
	const attrs = [`src="${esc(src)}"`];
	let alt = label;
	if (label !== undefined) {
		const parts = label.split("|");
		const size = /^(\d+)(?:x(\d+))?$/.exec(parts[parts.length - 1].trim());
		if (size) {
			parts.pop();
			attrs.push(`width="${size[1]}"`);
			if (size[2]) attrs.push(`height="${size[2]}"`);
		}
		alt = parts.join("|") || undefined;
	}
	attrs.push(`alt="${esc(alt ?? (parseLinktext(src).path || src))}"`);
	return `<span ${attrs.join(" ")} class="internal-embed" tabindex="-1" contenteditable="false"></span>`;
}

// Obsidian hides %%comments%%, inline or across lines, and an unclosed %%
// hides the rest of the note. Their text is blanked before block parsing, so
// line numbers stay those of the file; the frontmatter, fenced code and
// inline code keep their %%.
function stripComments(src: string) {
	if (!src.includes("%%")) return src;
	const lines = src.split("\n");
	let i = 0;
	if (lines[0] === "---") {
		const close = lines.indexOf("---", 1);
		if (close > 0) i = close + 1;
	}
	let fence: string | null = null;
	let inComment = false;
	for (; i < lines.length; i++) {
		const line = lines[i];
		if (!inComment) {
			const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
			if (fence) {
				if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.slice(f[0].length).trim()) fence = null;
				continue;
			}
			if (f) {
				fence = f[1];
				continue;
			}
		}
		let out = "";
		let j = 0;
		while (j < line.length) {
			if (inComment) {
				const close = line.indexOf("%%", j);
				if (close < 0) break;
				inComment = false;
				j = close + 2;
			} else if (line[j] === "\\") {
				out += line.slice(j, j + 2);
				j += 2;
			} else if (line[j] === "`") {
				const run = /^`+/.exec(line.slice(j))![0];
				let end = line.indexOf(run, j + run.length);
				while (end >= 0 && line[end + run.length] === "`") end = line.indexOf(run, end + run.length + 1);
				const stop = end < 0 ? j + run.length : end + run.length;
				out += line.slice(j, stop);
				j = stop;
			} else if (line.startsWith("%%", j)) {
				inComment = true;
				j += 2;
			} else {
				out += line[j++];
			}
		}
		lines[i] = out;
	}
	return lines.join("\n");
}

md.core.ruler.after("normalize", "comments", (state: StateCore) => {
	state.src = stripComments(state.src);
});

// The YAML at the top of a note is a section of its own, hidden, so section
// line numbers count from the start of the file.
md.block.ruler.before("table", "front_matter", (state, startLine, endLine, silent) => {
	const env = state.env as RenderEnv;
	if (startLine !== 0 || state.blkIndent !== 0 || env.inFootnote || state.src.slice(0, state.eMarks[0]) !== "---") return false;
	let close = 1;
	while (close < endLine && state.src.slice(state.bMarks[close], state.eMarks[close]) !== "---") close++;
	if (close >= endLine) return false;
	if (silent) return true;
	const token = state.push("front_matter", "", 0);
	token.block = true;
	token.content = state.getLines(1, close, 0, false).replace(/\n$/, "");
	token.map = [0, close + 1];
	env.frontmatter = token.content;
	state.line = close + 1;
	return true;
});
md.renderer.rules.front_matter = (tokens, idx) =>
	`<pre class="frontmatter language-yaml" tabindex="0" style="display: none;"><code class="language-yaml is-loaded">${esc(tokens[idx].content)}</code></pre>\n`;

// $$ blocks may interrupt a paragraph; `$$x$$ text` on one line is inline.
md.block.ruler.before(
	"fence",
	"math_block",
	(state, startLine, endLine, silent) => {
		if (state.sCount[startLine] - state.blkIndent >= 4) return false;
		const first = lineText(state, startLine);
		if (!first.startsWith("$$")) return false;
		const rest = first.slice(2);
		const close = rest.indexOf("$$");
		let next = startLine;
		let content: string;
		if (close >= 0) {
			if (rest.slice(close + 2).trim()) return false;
			content = rest.slice(0, close);
		} else {
			const lines = [rest];
			for (next = startLine + 1; next < endLine; next++) {
				const text = lineText(state, next);
				const end = text.indexOf("$$");
				if (end >= 0) {
					lines.push(text.slice(0, end));
					break;
				}
				lines.push(text);
			}
			content = lines.join("\n");
		}
		if (silent) return true;
		const token = state.push("math_block", "math", 0);
		token.block = true;
		token.content = content.trim();
		token.markup = "$$";
		token.map = [startLine, Math.min(next, endLine - 1) + 1];
		state.line = next + 1;
		return true;
	},
	{ alt: ["paragraph", "reference", "blockquote", "list"] },
);

// Inline math follows Pandoc: no space after the opening $ or before the
// closing one, and no digit right after it, so "$5 and $6" stays text.
// $$...$$ inside a paragraph is display math.
md.inline.ruler.after("escape", "math_inline", (state, silent) => {
	const { src, posMax } = state;
	const start = state.pos;
	if (src.charCodeAt(start) !== 0x24) return false;
	const display = src.charCodeAt(start + 1) === 0x24;
	const open = start + (display ? 2 : 1);
	if (open >= posMax || (!display && /\s/.test(src[open]))) return false;
	for (let i = open; i < posMax; i++) {
		const c = src.charCodeAt(i);
		if (c === 0x5c) {
			i++;
			continue;
		}
		if (c !== 0x24) continue;
		if (display ? src.charCodeAt(i + 1) !== 0x24 : /\s/.test(src[i - 1]) || /\d/.test(src[i + 1] ?? "")) continue;
		if (i === open) return false;
		if (!silent) {
			const token = state.push("math_inline", "math", 0);
			token.content = src.slice(open, i);
			token.markup = display ? "$$" : "$";
		}
		state.pos = i + (display ? 2 : 1);
		return true;
	}
	return false;
});
md.renderer.rules.math_inline = (tokens, idx) => {
	const token = tokens[idx];
	const cls = token.markup === "$$" ? "math math-block" : "math math-inline";
	return `<span class="${cls}" data-tex="${esc(token.content)}"></span>`;
};
md.renderer.rules.math_block = (tokens, idx) => `<div class="math math-block" data-tex="${esc(tokens[idx].content)}"></div>\n`;

md.inline.ruler.before("link", "wikilink", (state, silent) => {
	const { src, pos } = state;
	const embed = src.charCodeAt(pos) === 0x21;
	const open = pos + (embed ? 1 : 0);
	if (src.charCodeAt(open) !== 0x5b || src.charCodeAt(open + 1) !== 0x5b) return false;
	const close = src.indexOf("]]", open + 2);
	if (close < 0 || close > state.posMax) return false;
	const inner = src.slice(open + 2, close);
	if (!inner.trim() || inner.includes("\n") || inner.includes("[[")) return false;
	if (!silent) {
		// In tables the separator is written \| so the cell does not split.
		const sep = inner.search(/\\?\|/);
		const token = state.push(embed ? "embed" : "wikilink", "", 0);
		token.meta = {
			target: (sep < 0 ? inner : inner.slice(0, sep)).trim(),
			label: sep < 0 ? undefined : inner.slice(sep + (inner[sep] === "\\" ? 2 : 1)),
		};
	}
	state.pos = close + 2;
	return true;
});
md.renderer.rules.wikilink = (tokens, idx, _options, env) => {
	const { target, label } = tokens[idx].meta as { target: string; label?: string };
	const alias = label === undefined ? "" : ` aria-label="${esc(target)}" data-tooltip-position="top"`;
	return `<a ${internalLinkAttrs(target, envOf(env))}${alias}>${esc(label ?? linkDisplay(target))}</a>`;
};
md.renderer.rules.embed = (tokens, idx) => {
	const { target, label } = tokens[idx].meta as { target: string; label?: string };
	return embedPlaceholder(target, label);
};

// [t](https://x) opens in the browser; [t](Other%20note.md) is an internal
// link like [[Other note]], resolved against the note.
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const href = String(token.attrGet("href") ?? "");
	if (SCHEME.test(href)) token.attrJoin("class", "external-link");
	else {
		const linktext = decodeLink(href);
		token.attrSet("data-href", linktext);
		token.attrJoin("class", isResolved(linktext, envOf(env)) ? "internal-link" : "internal-link is-unresolved");
	}
	token.attrSet("target", "_blank");
	token.attrSet("rel", "noopener nofollow");
	return self.renderToken(tokens, idx, options);
};

// ![alt](local.png) embeds like ![[local.png]]; "alt|200" sizes the image.
md.renderer.rules.image = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	const src = String(token.attrGet("src") ?? "");
	const text = self.renderInlineAsText(token.children ?? [], options, env);
	const sized = /^(.*?)\|(\d+)(?:x(\d+))?$/.exec(text);
	if (!SCHEME.test(src) && !src.startsWith("//")) {
		return embedPlaceholder(decodeLink(src), sized ? `${sized[1]}|${sized[2]}${sized[3] ? `x${sized[3]}` : ""}` : text || undefined);
	}
	const size = sized ? ` width="${sized[2]}"${sized[3] ? ` height="${sized[3]}"` : ""}` : "";
	return `<img src="${esc(src)}" alt="${esc(sized ? sized[1] : text)}"${size}>`;
};

md.inline.ruler.after("escape", "tag", (state, silent) => {
	const { src, pos } = state;
	if (src.charCodeAt(pos) !== 0x23 || (pos > 0 && !/\s/.test(src[pos - 1]))) return false;
	const m = TAG.exec(src.slice(pos + 1, state.posMax));
	if (!m || /^\d+$/.test(m[0])) return false;
	if (!silent) state.push("tag", "", 0).content = `#${m[0]}`;
	state.pos += 1 + m[0].length;
	return true;
});
md.renderer.rules.tag = (tokens, idx) => {
	const tag = esc(tokens[idx].content);
	return `<a href="${tag}" class="tag" target="_blank" rel="noopener nofollow">${tag}</a>`;
};

// ==highlight== is a delimiter run like ~~strikethrough~~; this follows
// markdown-it's own strikethrough rule with "=".
md.inline.ruler.before("emphasis", "mark", (state, silent) => {
	const start = state.pos;
	if (silent || state.src.charCodeAt(start) !== 0x3d) return false;
	const scanned = state.scanDelims(start, true);
	let len = scanned.length;
	if (len < 2) return false;
	if (len % 2) {
		state.push("text", "", 0).content = "=";
		len--;
	}
	for (let i = 0; i < len; i += 2) {
		state.push("text", "", 0).content = "==";
		state.delimiters.push({ marker: 0x3d, length: 0, token: state.tokens.length - 1, end: -1, open: scanned.can_open, close: scanned.can_close });
	}
	state.pos += scanned.length;
	return true;
});

function markPairs(state: StateInline, delimiters: StateInline["delimiters"]) {
	const lone: number[] = [];
	for (const start of delimiters) {
		if (start.marker !== 0x3d || start.end === -1) continue;
		const end = delimiters[start.end];
		Object.assign(state.tokens[start.token], { type: "mark_open", tag: "mark", nesting: 1, markup: "==", content: "" });
		Object.assign(state.tokens[end.token], { type: "mark_close", tag: "mark", nesting: -1, markup: "==", content: "" });
		const prev = state.tokens[end.token - 1];
		if (prev.type === "text" && prev.content === "=") lone.push(end.token - 1);
	}
	// A lone "=" before closing markers belongs outside them.
	while (lone.length) {
		const i = lone.pop()!;
		let j = i + 1;
		while (j < state.tokens.length && state.tokens[j].type === "mark_close") j++;
		j--;
		if (i !== j) [state.tokens[i], state.tokens[j]] = [state.tokens[j], state.tokens[i]];
	}
}
md.inline.ruler2.before("emphasis", "mark", (state) => {
	markPairs(state, state.delimiters);
	for (const meta of state.tokens_meta) if (meta?.delimiters) markPairs(state, meta.delimiters);
	return false;
});

md.renderer.rules.s_open = () => "<del>";
md.renderer.rules.s_close = () => "</del>";

// Footnotes: [^label] with a [^label]: definition, and ^[inline] notes, all
// numbered by first reference and listed in a section at the end.
function footnoteState(env: RenderEnv) {
	env.footnotes ??= { defs: new Map(), notes: [], byLabel: new Map() };
	return env.footnotes;
}

md.block.ruler.before(
	"reference",
	"footnote_def",
	(state, startLine, endLine, silent) => {
		if (state.sCount[startLine] - state.blkIndent >= 4) return false;
		const first = lineText(state, startLine);
		const m = /^\[\^([^\]\s]+)\]:[ \t]?/.exec(first);
		if (!m) return false;
		if (silent) return true;
		const terminators = state.md.block.ruler.getRules("paragraph");
		const lines = [first.slice(m[0].length)];
		let next = startLine + 1;
		for (; next < endLine; next++) {
			if (state.isEmpty(next)) {
				// Blank lines continue the note only when indented text follows.
				let k = next + 1;
				while (k < endLine && state.isEmpty(k)) k++;
				if (k >= endLine || state.sCount[k] - state.blkIndent < 4) break;
				for (; next < k; next++) lines.push("");
				next--;
				continue;
			}
			if (state.sCount[next] - state.blkIndent >= 4) {
				lines.push(state.src.slice(state.bMarks[next], state.eMarks[next]).replace(/^(?: {1,4}|\t)/, ""));
				continue;
			}
			if (lines[lines.length - 1] === "") break;
			const parent = state.parentType;
			state.parentType = "paragraph";
			const interrupted = terminators.some((rule) => rule(state, next, endLine, true));
			state.parentType = parent;
			if (interrupted) break;
			lines.push(lineText(state, next));
		}
		const notes = footnoteState(state.env as RenderEnv);
		if (!notes.defs.has(m[1])) notes.defs.set(m[1], { text: lines.join("\n").trim(), start: startLine, end: next });
		const token = state.push("footnote_def", "", 0);
		token.block = true;
		token.meta = { label: m[1] };
		token.map = [startLine, next];
		state.line = next;
		return true;
	},
	{ alt: ["paragraph", "reference"] },
);
md.renderer.rules.footnote_def = () => "";

md.inline.ruler.before("link", "footnote_ref", (state, silent) => {
	const { src, pos } = state;
	if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5e) return false;
	const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(pos, state.posMax));
	const notes = footnoteState(state.env as RenderEnv);
	if (!m || !notes.defs.has(m[1])) return false;
	if (!silent) {
		let index = notes.byLabel.get(m[1]);
		if (index === undefined) {
			index = notes.notes.push({ label: m[1], refs: 0 }) - 1;
			notes.byLabel.set(m[1], index);
		}
		state.push("footnote_ref", "", 0).meta = { index, ref: notes.notes[index].refs++ };
	}
	state.pos += m[0].length;
	return true;
});

md.inline.ruler.after("footnote_ref", "footnote_inline", (state, silent) => {
	const { src, pos } = state;
	if (src.charCodeAt(pos) !== 0x5e || src.charCodeAt(pos + 1) !== 0x5b) return false;
	const end = state.md.helpers.parseLinkLabel(state, pos + 1);
	if (end < 0) return false;
	if (!silent) {
		const notes = footnoteState(state.env as RenderEnv);
		const tokens: Token[] = [];
		state.md.inline.parse(src.slice(pos + 2, end), state.md, state.env, tokens);
		const index = notes.notes.push({ tokens, refs: 1 }) - 1;
		state.push("footnote_ref", "", 0).meta = { index, ref: 0 };
	}
	state.pos = end + 1;
	return true;
});

md.core.ruler.after("inline", "footnote_tail", (state) => {
	const env = state.env as RenderEnv;
	const notes = env.footnotes;
	if (!notes?.notes.length) return;
	const T = state.Token;
	const open = new T("footnote_block_open", "", 1);
	const lines = notes.notes.flatMap((n) => {
		const def = n.label === undefined ? undefined : notes.defs.get(n.label);
		return def ? [def.start, def.end] : [];
	});
	if (lines.length) open.map = [Math.min(...lines), Math.max(...lines)];
	const out: Token[] = [open];
	notes.notes.forEach((note, index) => {
		const item = new T("footnote_open", "", 1);
		item.meta = { index };
		let content: Token[];
		if (note.tokens) {
			const inline = new T("inline", "", 0);
			inline.children = note.tokens;
			content = [new T("paragraph_open", "p", 1), inline, new T("paragraph_close", "p", -1)];
		} else {
			content = [];
			env.inFootnote = true;
			state.md.block.parse(notes.defs.get(note.label!)!.text, state.md, env, content);
			for (const t of content) {
				if (t.type !== "inline") continue;
				t.children = [];
				state.md.inline.parse(t.content, state.md, env, t.children);
			}
			env.inFootnote = false;
		}
		const anchor = new T("footnote_anchor", "", 0);
		anchor.meta = { index };
		if (content[content.length - 1]?.type === "paragraph_close") content.splice(content.length - 1, 0, anchor);
		else content.push(anchor);
		out.push(item, ...content, new T("footnote_close", "", -1));
	});
	out.push(new T("footnote_block_close", "", -1));
	state.tokens.push(...out);
});

const fnId = (env: RenderEnv, index: number, ref = 0) => `${index + 1}${ref ? `-${ref}` : ""}-${env.docId}`;
md.renderer.rules.footnote_ref = (tokens, idx, _options, env) => {
	const { index, ref } = tokens[idx].meta as { index: number; ref: number };
	const id = `fnref-${fnId(envOf(env), index, ref)}`;
	return `<sup data-footnote-id="${id}" class="footnote-ref" id="${id}"><a href="#fn-${fnId(envOf(env), index)}" class="footnote-link" target="_self" rel="noopener nofollow">[${index + 1}]</a></sup>`;
};
md.renderer.rules.footnote_block_open = () => '<section class="footnotes"><hr class="footnotes-sep"><ol class="footnotes-list">\n';
md.renderer.rules.footnote_block_close = () => "</ol></section>\n";
md.renderer.rules.footnote_open = (tokens, idx, _options, env) => {
	const id = `fn-${fnId(envOf(env), (tokens[idx].meta as { index: number }).index)}`;
	return `<li data-footnote-id="${id}" id="${id}">`;
};
md.renderer.rules.footnote_close = () => "</li>\n";
md.renderer.rules.footnote_anchor = (tokens, idx, _options, env) =>
	` <a href="#fnref-${fnId(envOf(env), (tokens[idx].meta as { index: number }).index)}" class="footnote-backref footnote-link" target="_self" rel="noopener nofollow">↩︎</a>`;

interface CalloutMeta {
	type: string;
	metadata?: string;
	fold: string;
}

// > [!type|metadata]+/- Title: a callout. The marker line becomes the title,
// the rest of the quote its content.
md.core.ruler.after("block", "callouts", (state) => {
	const tokens = state.tokens;
	const T = state.Token;
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type !== "blockquote_open" || tokens[i + 1]?.type !== "paragraph_open" || tokens[i + 2]?.type !== "inline") continue;
		const inline = tokens[i + 2];
		const newline = inline.content.indexOf("\n");
		const m = CALLOUT.exec(newline < 0 ? inline.content : inline.content.slice(0, newline));
		if (!m) continue;
		let close = i + 1;
		for (let depth = 1; close < tokens.length; close++) {
			if (tokens[close].type === "blockquote_open") depth++;
			else if (tokens[close].type === "blockquote_close" && --depth === 0) break;
		}
		const type = m[1].trim().toLowerCase();
		const open = tokens[i];
		open.type = "callout_open";
		open.tag = "div";
		open.meta = { type, metadata: m[2], fold: m[3] };
		tokens[close].type = "callout_close";
		tokens[close].tag = "div";
		const title = new T("inline", "", 0);
		title.content = m[4].trim() || type.charAt(0).toUpperCase() + type.slice(1);
		title.children = [];
		title.map = inline.map;
		const rest = newline < 0 ? "" : inline.content.slice(newline + 1);
		tokens.splice(close, 0, new T("callout_content_close", "div", -1));
		if (rest.trim()) inline.content = rest;
		else tokens.splice(i + 1, 3);
		const head = [new T("callout_title_open", "div", 1), title, new T("callout_title_close", "div", -1), new T("callout_content_open", "div", 1)];
		head[0].meta = open.meta;
		head[3].meta = open.meta;
		tokens.splice(i + 1, 0, ...head);
	}
});
md.renderer.rules.callout_open = (tokens, idx) => {
	const { type, metadata, fold } = tokens[idx].meta as unknown as CalloutMeta;
	const attrs = [metadata ? `data-callout-metadata="${esc(metadata)}"` : "", fold ? `data-callout-fold="${fold}"` : "", `data-callout="${esc(type)}"`];
	const cls = ["callout", fold ? "is-collapsible" : "", fold === "-" ? "is-collapsed" : ""].filter(Boolean).join(" ");
	return `<div ${attrs.filter(Boolean).join(" ")} class="${cls}">\n`;
};
md.renderer.rules.callout_close = () => "</div>\n";
md.renderer.rules.callout_title_open = () => '<div class="callout-title" dir="auto"><div class="callout-icon"></div><div class="callout-title-inner">';
md.renderer.rules.callout_title_close = (tokens, idx) => {
	const fold = (tokens[idx - 2]?.meta as CalloutMeta | null)?.fold;
	return `</div>${fold ? `<div class="callout-fold${fold === "-" ? " is-collapsed" : ""}"></div>` : ""}</div>\n`;
};
md.renderer.rules.callout_content_open = (tokens, idx) =>
	(tokens[idx].meta as CalloutMeta | null)?.fold === "-" ? '<div class="callout-content" style="display: none;">\n' : '<div class="callout-content">\n';
md.renderer.rules.callout_content_close = () => "</div>\n";

// A trailing ^block-id names the block for links and embeds; reading view
// does not show it, nor a line holding only the id.
md.core.ruler.after("callouts", "block_ids", (state) => {
	const tokens = state.tokens;
	for (let i = 1; i < tokens.length; i++) {
		const inline = tokens[i];
		if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open") continue;
		const m = BLOCK_ID.exec(inline.content);
		if (!m) continue;
		inline.content = inline.content.slice(0, m.index).trimEnd();
		if (!inline.content && tokens[i - 1].level === 0) {
			tokens.splice(i - 1, 3);
			i -= 2;
		}
	}
});

// - [ ] and - [x] (or any status character) are task items.
md.core.ruler.push("task_lists", (state) => {
	const tokens = state.tokens;
	for (let i = 2; i < tokens.length; i++) {
		const inline = tokens[i];
		if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
		const m = /^\[([^\]\n])\](?=\s|$)/.exec(inline.content);
		const first = inline.children?.[0];
		if (!m || first?.type !== "text" || !first.content.startsWith(m[0])) continue;
		first.content = first.content.slice(m[0].length).replace(/^[ \t]/, "");
		const item = tokens[i - 2];
		item.meta = { ...item.meta, task: m[1] };
		const box = new state.Token("task_checkbox", "input", 0);
		box.meta = { task: m[1], line: item.map?.[0] ?? 0 };
		inline.children!.unshift(box);
		for (let j = i - 3; j >= 0; j--) {
			const list = tokens[j];
			if ((list.type === "bullet_list_open" || list.type === "ordered_list_open") && list.level === item.level - 1) {
				if (!String(list.attrGet("class") ?? "").includes("contains-task-list")) list.attrJoin("class", "contains-task-list");
				break;
			}
		}
	}
});
md.renderer.rules.task_checkbox = (tokens, idx, _options, env) => {
	const { task, line } = tokens[idx].meta as { task: string; line: number };
	return `<input data-line="${line - (envOf(env).sectionLine ?? 0)}" class="task-list-item-checkbox" type="checkbox"${task === " " ? "" : " checked"}>`;
};

// Obsidian's attributes on block elements: dir="auto", data-heading for
// heading anchors, data-line on list items (relative to the section).
md.renderer.rules.paragraph_open = (tokens, idx, options, _env, self) => {
	tokens[idx].attrSet("dir", "auto");
	return self.renderToken(tokens, idx, options);
};
md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
	const text = (tokens[idx + 1]?.children ?? [])
		.map((t) => {
			if (t.type === "text" || t.type === "code_inline" || t.type === "tag") return t.content;
			if (t.type === "math_inline") return `$${t.content}$`;
			if (t.type === "wikilink") {
				const { target, label } = t.meta as { target: string; label?: string };
				return label ?? linkDisplay(target);
			}
			return "";
		})
		.join("")
		.trim();
	tokens[idx].attrSet("data-heading", text);
	tokens[idx].attrSet("dir", "auto");
	return self.renderToken(tokens, idx, options);
};
md.renderer.rules.list_item_open = (tokens, idx, options, env, self) => {
	const token = tokens[idx];
	if (token.map) token.attrSet("data-line", String(token.map[0] - (envOf(env).sectionLine ?? 0)));
	const task = (token.meta as { task?: string } | null)?.task;
	if (task !== undefined) {
		token.attrSet("data-task", task);
		token.attrSet("class", task === " " ? "task-list-item" : "task-list-item is-checked");
	}
	token.attrSet("dir", "auto");
	return self.renderToken(tokens, idx, options);
};

function codeBlockHTML(text: string, lang: string, env: RenderEnv) {
	let code = esc(text);
	const grammar = lang && env.prism && !env.skipHighlight?.(lang) ? env.prism.languages[lang] : undefined;
	if (grammar) code = env.prism.highlight(text, grammar, lang);
	const cls = lang ? `language-${esc(lang)}` : "";
	return `<pre${cls ? ` class="${cls}"` : ""} tabindex="0"><code${cls ? ` class="${cls} is-loaded"` : ""}>${code}</code><button class="copy-code-button">Copy</button></pre>\n`;
}
md.renderer.rules.fence = (tokens, idx, _options, env) =>
	codeBlockHTML(tokens[idx].content.replace(/\n$/, ""), tokens[idx].info.trim().split(/\s+/)[0] ?? "", envOf(env));
md.renderer.rules.code_block = (tokens, idx, _options, env) => codeBlockHTML(tokens[idx].content.replace(/\n$/, ""), "", envOf(env));

// ---------------------------------------------------------------------------
// Sections: the top-level blocks of a note with their line ranges.

export interface MarkdownRenderedSection {
	lineStart: number;
	lineEnd: number;
	html: string;
}

function toSections(markdown: string, tokens: Token[], env: RenderEnv, breaks: boolean) {
	const options = { ...md.options, breaks };
	const lines = markdown.split(/\r?\n/);
	const sections: MarkdownRenderedSection[] = [];
	let depth = 0;
	let start = 0;
	let line = 0;
	for (let i = 0; i < tokens.length; i++) {
		if (depth === 0) start = i;
		depth += tokens[i].nesting;
		if (depth !== 0) continue;
		const map = tokens[start].map;
		const lineStart = map?.[0] ?? line;
		let lineEnd = Math.max(lineStart, (map?.[1] ?? lineStart + 1) - 1);
		// markdown-it counts the blank lines after a list into it.
		while (lineEnd > lineStart && !lines[lineEnd]?.trim()) lineEnd--;
		line = lineEnd + 1;
		env.sectionLine = lineStart;
		sections.push({ lineStart, lineEnd, html: md.renderer.render(tokens.slice(start, i + 1), options, env) });
	}
	return sections;
}

interface SectionOptions {
	sourcePath?: string;
	docId?: string;
	resolve?(linkpath: string): boolean;
	strictLineBreaks?: boolean;
	prism?: any;
}

// justnotes: Markdown as Obsidian's top-level sections, each with its line
// range (0-based, counted from the top of the file) and unsanitized HTML, and
// the parsed frontmatter.
export function renderMarkdownSections(markdown: string, options: SectionOptions = {}) {
	const env: RenderEnv = {
		sourcePath: options.sourcePath ?? "",
		docId: options.docId ?? randomId(),
		resolve: options.resolve ?? (() => true),
		prism: options.prism,
	};
	const sections = toSections(markdown, md.parse(markdown, env), env, !options.strictLineBreaks);
	return { sections, frontmatter: parseFrontmatter(env) };
}

function parseFrontmatter(env: RenderEnv) {
	if (env.frontmatter === undefined) return null;
	try {
		return parseYaml(env.frontmatter) ?? null;
	} catch {
		return null;
	}
}

const randomId = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// Libraries Obsidian exposes. They load on first use from dist/lib (build.ts),
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
		// The sources getDocument itself accepts: a URL, the bytes, or parameters.
		const withAssets = (src: any) => {
			const params = typeof src === "string" || src instanceof URL ? { url: src } : src instanceof ArrayBuffer || ArrayBuffer.isView(src) ? { data: src } : { ...src };
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

// ---------------------------------------------------------------------------
// From HTML to the page: section bookkeeping, placeholders, embeds.

// Each rendered top-level block (or a section's wrapper) maps to its line
// range for getSectionInfo. The records are shared, so a reading view can
// shift a kept section's lines in place.
const sectionInfo = new WeakMap<Element, MarkdownSectionInformation>();

function sectionInfoOf(el: HTMLElement): MarkdownSectionInformation | null {
	for (let node: Element | null = el; node; node = node.parentElement) {
		const info = sectionInfo.get(node);
		if (info) return { ...info };
	}
	return null;
}

function transferSection(from: Element, to: Element) {
	const info = sectionInfo.get(from);
	if (info) sectionInfo.set(to, info);
}

interface RenderJob {
	app: App;
	owner: MarkdownRenderer;
	// Where components that belong to this render's output are added.
	parent: Component;
	sourcePath: string;
	embedStack: string[];
	promises: Promise<unknown>[];
}

function createEnv(app: App, sourcePath: string, docId: string): RenderEnv {
	return {
		sourcePath,
		docId,
		resolve: (linkpath) => !!app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath),
		skipHighlight: (lang) => lang === "mermaid" || lang in MarkdownPreviewRenderer.codeBlockPostProcessors,
	};
}

async function loadLibrariesFor(tokens: Token[], markdown: string, env: RenderEnv) {
	const loads: Promise<unknown>[] = [];
	if (markdown.includes("$")) loads.push(loadMathJax().catch((err) => console.error(err)));
	if (tokens.some((t) => t.type === "fence" && t.info.trim())) loads.push(loadPrism().then((p) => (env.prism = p), (err) => console.error(err)));
	await Promise.all(loads);
}

const breaksFor = (app: App) => !app.vault.getConfig("strictLineBreaks");

const CALLOUT_ICONS: Record<string, string> = {
	note: "lucide-pencil",
	abstract: "lucide-clipboard-list",
	summary: "lucide-clipboard-list",
	tldr: "lucide-clipboard-list",
	info: "lucide-info",
	todo: "lucide-check-circle-2",
	tip: "lucide-flame",
	hint: "lucide-flame",
	important: "lucide-flame",
	success: "lucide-check",
	check: "lucide-check",
	done: "lucide-check",
	question: "lucide-help-circle",
	help: "lucide-help-circle",
	faq: "lucide-help-circle",
	warning: "lucide-alert-triangle",
	caution: "lucide-alert-triangle",
	attention: "lucide-alert-triangle",
	failure: "lucide-x",
	fail: "lucide-x",
	missing: "lucide-x",
	danger: "lucide-zap",
	error: "lucide-zap",
	bug: "lucide-bug",
	example: "lucide-list",
	quote: "lucide-quote",
	cite: "lucide-quote",
};

// The icon comes from --callout-icon, which themes and snippets may set for
// their own types; a detached callout falls back to the built-in table.
function calloutIcon(callout: HTMLElement) {
	const fromCss = callout.isConnected ? getComputedStyle(callout).getPropertyValue("--callout-icon").trim() : "";
	return fromCss || CALLOUT_ICONS[callout.dataset.callout ?? ""] || CALLOUT_ICONS.note;
}

// Sanitized HTML for the page. Raw HTML may point at vault files relative to
// the note; those sources become resource URLs before anything loads.
function toDom(html: string, app: App, sourcePath: string) {
	return sanitizeHTML(html, (fragment) => {
		for (const el of Array.from(fragment.querySelectorAll("img[src], video[src], audio[src], source[src], iframe[src]"))) {
			const src = el.getAttribute("src")!;
			if (SCHEME.test(src) || src.startsWith("/") || src.startsWith("#")) continue;
			const file = app.metadataCache.getFirstLinkpathDest(decodeLink(src), sourcePath);
			if (file) el.setAttribute("src", app.vault.getResourcePath(file));
		}
	});
}

// Fills what the sanitized HTML leaves as placeholders in `root`: math,
// callout icons and embeds (whose loading joins job.promises).
function enhance(root: HTMLElement, job: RenderJob) {
	for (const el of root.findAllSelf(".math[data-tex]")) {
		const tex = el.getAttribute("data-tex") ?? "";
		el.removeAttribute("data-tex");
		el.appendChild(renderMath(tex, el.hasClass("math-block")));
		el.addClass("is-loaded");
	}
	for (const callout of root.findAllSelf(".callout") as HTMLElement[]) {
		const icon = callout.find(":scope > .callout-title > .callout-icon") as HTMLElement | null;
		if (icon && !icon.firstChild) setIcon(icon, calloutIcon(callout));
		const fold = callout.find(":scope > .callout-title > .callout-fold") as HTMLElement | null;
		if (fold && !fold.firstChild) setIcon(fold, "lucide-chevron-down");
	}
	for (const embed of root.findAllSelf("span.internal-embed:not(.is-loaded)") as HTMLElement[]) {
		job.promises.push(loadEmbed(embed, job).catch((err) => console.error(err)));
	}
}

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const AUDIO_EXTENSIONS = new Set(["flac", "m4a", "mp3", "ogg", "wav", "3gp"]);
const VIDEO_EXTENSIONS = new Set(["mkv", "mov", "mp4", "ogv", "webm"]);
const MAX_EMBED_DEPTH = 5;

async function loadEmbed(embed: HTMLElement, job: RenderJob) {
	const { app } = job;
	const src = embed.getAttribute("src") ?? "";
	const { path, subpath } = parseLinktext(src);
	const file = app.metadataCache.getFirstLinkpathDest(path, job.sourcePath);
	embed.addClass("is-loaded");
	if (!file) {
		embed.addClasses(["file-embed", "mod-empty"]);
		const name = path || src;
		const note = !/\.[^/]+$/.test(name) || name.endsWith(".md");
		embed.createDiv({ cls: "file-embed-title", text: note ? `"${name}" is not created yet. Click to create.` : `"${name}" could not be found.` });
		return;
	}
	const ext = file.extension.toLowerCase();
	const size = { width: embed.getAttribute("width"), height: embed.getAttribute("height") };
	if (IMAGE_EXTENSIONS.has(ext)) {
		embed.addClasses(["media-embed", "image-embed"]);
		embed.createEl("img", { attr: { alt: embed.getAttribute("alt"), src: app.vault.getResourcePath(file), ...size } });
	} else if (AUDIO_EXTENSIONS.has(ext)) {
		embed.addClasses(["media-embed", "audio-embed"]);
		embed.createEl("audio", { attr: { controls: true, src: app.vault.getResourcePath(file) } });
	} else if (VIDEO_EXTENSIONS.has(ext)) {
		embed.addClasses(["media-embed", "video-embed"]);
		embed.createEl("video", { attr: { controls: true, src: app.vault.getResourcePath(file), ...size } });
	} else if (ext === "pdf") {
		await embedPdf(embed, file, subpath, job);
	} else if (ext === "md") {
		await embedNote(embed, file, subpath, job);
	} else {
		embed.addClasses(["file-embed", "mod-generic"]);
		const title = embed.createDiv("file-embed-title");
		setIcon(title.createSpan("file-embed-icon"), "lucide-file");
		title.appendText(` ${file.name}`);
	}
}

// The lines of `text` that `subpath` names: a heading's section (to the next
// heading of the same or a higher level), or the block with ^id. Null when
// the note has no such heading or block.
function sliceSubpath(text: string, subpath: string) {
	if (!subpath) return text;
	const lines = text.split("\n");
	const tokens = md.parse(text, { sourcePath: "", docId: "", resolve: () => true } satisfies RenderEnv);
	const range = (start: number, end: number) => lines.slice(start, end).join("\n");
	if (subpath.startsWith("#^")) {
		const id = subpath.slice(2).toLowerCase();
		const line = lines.findIndex((l) => BLOCK_ID.exec(l)?.[1].toLowerCase() === id);
		if (line < 0) return null;
		const blocks = tokens.filter((t) => t.map && t.nesting >= 0 && t.level === 0);
		// A line holding only the id belongs to the block it continues; after a
		// blank line it is a paragraph of its own and names the block above.
		const lone = !lines[line].replace(BLOCK_ID, "").trim();
		const holds = (t: Token) => t.map![0] <= line && line < t.map![1] && !(lone && t.map![0] === line);
		const item = tokens.filter((t) => t.type === "list_item_open" && t.map && holds(t)).pop();
		const block = item ?? blocks.find(holds);
		if (block) return range(block.map![0], block.map![1]);
		if (!lone) return range(line, line + 1);
		const above = blocks.filter((t) => t.map![1] <= line).pop();
		return above ? range(above.map![0], above.map![1]) : null;
	}
	const headings: { line: number; level: number; text: string }[] = [];
	tokens.forEach((t, i) => {
		if (t.type === "heading_open" && t.map && t.level === 0) headings.push({ line: t.map[0], level: Number(t.tag.slice(1)), text: tokens[i + 1].content });
	});
	const key = (s: string) => stripHeading(s).toLowerCase();
	let from = 0;
	let match: (typeof headings)[number] | undefined;
	for (const name of subpath.split("#").filter(Boolean).map(key)) {
		match = headings.find((h) => h.line >= from && key(h.text) === name);
		if (!match) return null;
		from = match.line + 1;
	}
	if (!match) return text;
	const end = headings.find((h) => h.line > match!.line && h.level <= match!.level);
	return range(match.line, end ? end.line : lines.length);
}

async function embedNote(embed: HTMLElement, file: TFile, subpath: string, job: RenderJob) {
	const { app } = job;
	embed.addClasses(["markdown-embed", "inline-embed"]);
	embed.createDiv("embed-title markdown-embed-title");
	const content = embed.createDiv("markdown-embed-content");
	const link = embed.createDiv({ cls: "markdown-embed-link", attr: { "aria-label": "Open link" } });
	setIcon(link, "lucide-link");
	const key = file.path + subpath;
	if (job.embedStack.includes(key) || job.embedStack.length >= MAX_EMBED_DEPTH) {
		content.createDiv({ cls: "markdown-embed-loop", text: `"${file.basename}" is already embedded here.` });
		return;
	}
	const embedChild = job.parent.addChild(new MarkdownRenderChild(embed));
	let inner: Component | null = null;
	const render = async () => {
		const text = await app.vault.cachedRead(file);
		if (inner) embedChild.removeChild(inner);
		inner = embedChild.addChild(new Component());
		content.empty();
		const slice = sliceSubpath(text, subpath);
		if (slice === null) {
			content.createDiv({ cls: "markdown-embed-empty", text: `Unable to find section ${subpath} in ${file.basename}` });
			return;
		}
		const view = content.createDiv("markdown-preview-view markdown-rendered show-indentation-guide");
		const sizer = view.createDiv("markdown-preview-sizer markdown-preview-section");
		await renderStatic(app, slice, sizer, file.path, inner, [...job.embedStack, key]);
	};
	embedChild.registerEvent(
		app.vault.on("modify", (changed: TFile) => {
			if (changed === file) render().catch((err) => console.error(err));
		}),
	);
	await render();
}

// A PDF embed shows its pages one under another, rendered by pdf.js when they
// scroll into view. #page=N opens at that page, #height=N sets the viewer height.
async function embedPdf(embed: HTMLElement, file: TFile, subpath: string, job: RenderJob) {
	embed.addClass("pdf-embed");
	const params = new URLSearchParams(subpath.replace(/^#/, ""));
	const viewer = embed.createDiv("pdf-embed-viewer");
	const height = Number(params.get("height"));
	if (height > 0) viewer.style.height = `${height}px`;
	const child = job.parent.addChild(new MarkdownRenderChild(embed));
	const lib = await loadPdfJs();
	const doc = await lib.getDocument({ data: new Uint8Array(await job.app.vault.readBinary(file)) }).promise;
	child.register(() => doc.destroy());
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				observer.unobserve(entry.target);
				renderPdfPage(lib, doc, entry.target as HTMLElement).catch((err) => console.error(err));
			}
		},
		{ root: viewer, rootMargin: "200px 0px" },
	);
	child.register(() => observer.disconnect());
	const first = (await doc.getPage(1)).getViewport({ scale: 1 });
	for (let n = 1; n <= doc.numPages; n++) {
		const pageEl = viewer.createDiv({ cls: "pdf-embed-page", attr: { "data-page": n } });
		pageEl.style.aspectRatio = `${first.width} / ${first.height}`;
		observer.observe(pageEl);
	}
	const page = Math.min(doc.numPages, Math.max(1, Number(params.get("page")) || 1));
	const pages = viewer.children as HTMLCollectionOf<HTMLElement>;
	if (page > 1) requestAnimationFrame(() => (viewer.scrollTop = pages[page - 1].offsetTop - pages[0].offsetTop));
}

// A page is a canvas plus pdf.js's text layer, so its text can be selected.
async function renderPdfPage(lib: any, doc: any, pageEl: HTMLElement) {
	const page = await doc.getPage(Number(pageEl.dataset.page));
	const css = page.getViewport({ scale: Math.max(pageEl.clientWidth, 200) / page.getViewport({ scale: 1 }).width });
	// Placeholders take the first page's shape; a page of another size keeps its own.
	pageEl.style.aspectRatio = `${css.width} / ${css.height}`;
	const viewport = page.getViewport({ scale: css.scale * window.devicePixelRatio });
	const canvas = pageEl.createEl("canvas");
	canvas.width = Math.floor(viewport.width);
	canvas.height = Math.floor(viewport.height);
	await page.render({ canvasContext: canvas.getContext("2d")!, canvas, viewport }).promise;
	const text = pageEl.createDiv("textLayer");
	// pdf.js sizes its spans from the variables its own viewer CSS would set.
	text.setCssProps({ "--total-scale-factor": String(css.scale), "--scale-round-x": "1px", "--scale-round-y": "1px" });
	await new lib.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport: css }).render();
}

// Mermaid fences are a built-in code-block processor, registered last so a
// plugin's own "mermaid" processor wins.
async function renderMermaidBlock(source: string, el: HTMLElement) {
	el.addClass("mermaid");
	const m = await loadMermaid();
	const id = `mermaid-${randomId()}`;
	try {
		m.initialize({ startOnLoad: false, theme: document.body.hasClass("theme-dark") ? "dark" : "default" });
		const { svg } = await m.render(id, source);
		el.innerHTML = svg;
	} catch (err) {
		document.getElementById(`d${id}`)?.remove();
		el.createEl("pre", { cls: "mermaid-error", text: String((err as Error)?.message ?? err) });
	}
}

function runPostProcessors(el: HTMLElement, ctx: MarkdownPostProcessorContext, promises: Promise<unknown>[]) {
	for (const pp of [...postProcessors]) {
		try {
			const result = pp(el, ctx);
			if (isPromise(result)) promises.push(result.catch((err) => console.error(err)));
		} catch (err) {
			console.error(err);
		}
	}
}

function postProcessorContext(job: RenderJob, docId: string, frontmatter: unknown, containerEl: HTMLElement, el: HTMLElement) {
	return {
		docId,
		sourcePath: job.sourcePath,
		frontmatter,
		addChild: (child: Component) => job.parent.addChild(child),
		getSectionInfo: sectionInfoOf,
		containerEl,
		el,
		promises: job.promises,
	};
}

// ---------------------------------------------------------------------------
// Events on rendered output, shared by every renderer: links open in the app
// (never by navigating the window), tags search, footnotes scroll, code
// copies, callouts fold. A nested render (an embed) handles its own events
// first with its own source path; the outer one then leaves them alone.
const handledEvents = new WeakSet<Event>();

function attachHandlers(owner: MarkdownRenderer, el: HTMLElement, sourcePath: () => string, taskLines: boolean) {
	const click = (evt: MouseEvent) => {
		if (evt.defaultPrevented || handledEvents.has(evt)) return;
		handledEvents.add(evt);
		const target = evt.target as Element;
		const a = target.closest("a");
		if (a && el.contains(a)) {
			if (a.hasClass("internal-link")) return owner.onInternalLinkClick(evt, a, a.getAttribute("data-href") ?? "", sourcePath());
			if (a.hasClass("tag")) return owner.onTagClick(evt, a, a.getText());
			if (a.hasClass("footnote-link")) return owner.onFootnoteLinkClick(evt, a, (a.getAttribute("href") ?? "").slice(1));
			const href = a.getAttribute("href");
			if (!href) return evt.preventDefault();
			if (!SCHEME.test(href)) return owner.onInternalLinkClick(evt, a, decodeLink(href), sourcePath());
			return owner.onExternalLinkClick(evt, a, href);
		}
		const copy = target.closest(".copy-code-button");
		if (copy && el.contains(copy)) {
			evt.preventDefault();
			navigator.clipboard.writeText(copy.parentElement?.find("code")?.textContent ?? "");
			copy.setText("Copied!");
			setTimeout(() => copy.setText("Copy"), 1500);
			return;
		}
		const box = target.closest("input.task-list-item-checkbox") as HTMLInputElement | null;
		if (box && el.contains(box)) {
			const info = taskLines ? sectionInfoOf(box) : null;
			return owner.onCheckboxClick(evt, box, info ? info.lineStart + Number(box.dataset.line ?? 0) : null);
		}
		const embed = target.closest(".markdown-embed-link, .file-embed");
		if (embed && el.contains(embed)) {
			const linktext = embed.closest(".internal-embed")?.getAttribute("src");
			if (linktext) owner.app.workspace.openLinkText(linktext, sourcePath(), Keymap.isModEvent(evt));
			return;
		}
		const title = target.closest(".callout-title");
		const callout = title?.parentElement;
		if (callout && el.contains(callout) && callout.hasClass("is-collapsible")) {
			const collapsed = !callout.hasClass("is-collapsed");
			callout.toggleClass("is-collapsed", collapsed);
			callout.find(":scope > .callout-title > .callout-fold")?.toggleClass("is-collapsed", collapsed);
			(callout.find(":scope > .callout-content") as HTMLElement | null)?.toggle(!collapsed);
		}
	};
	owner.registerDomEvent(el, "click", click);
	// A middle click on a link would otherwise open it as a new window.
	owner.registerDomEvent(el, "auxclick", (evt: MouseEvent) => {
		if (evt.button === 1) click(evt);
	});
	owner.registerDomEvent(el, "mouseover", (evt: MouseEvent) => {
		if (handledEvents.has(evt)) return;
		const a = (evt.target as Element).closest("a.internal-link");
		if (!a || !el.contains(a) || (evt.relatedTarget instanceof Node && a.contains(evt.relatedTarget))) return;
		handledEvents.add(evt);
		owner.onInternalLinkMouseover(evt, a as HTMLElement, a.getAttribute("data-href") ?? "", sourcePath());
	});
	owner.registerDomEvent(el, "contextmenu", (evt: MouseEvent) => {
		if (evt.defaultPrevented || handledEvents.has(evt)) return;
		const a = (evt.target as Element).closest("a.internal-link");
		if (!a || !el.contains(a)) return;
		handledEvents.add(evt);
		owner.onInternalLinkContextMenu(evt, a as HTMLElement, a.getAttribute("data-href") ?? "", sourcePath());
	});
}

// ---------------------------------------------------------------------------

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

// Obsidian's renderer of Markdown output: it owns the output's event
// handling (MarkdownPreviewEvents) and its hover popover (HoverParent).
// MarkdownRenderer.render uses an internal subclass per call; the reading
// view subclasses it too and may override the on* hooks.
export class MarkdownRenderer extends MarkdownRenderChild {
	app: App;
	// The open page preview, set by the workspace's HoverPopover.
	hoverPopover: Component | null = null;

	constructor(app: App, containerEl: HTMLElement) {
		super(containerEl);
		this.app = app;
	}

	get file(): TFile | null {
		return null;
	}

	onInternalLinkClick(evt: MouseEvent, target: HTMLElement, linktext: string, sourcePath: string) {
		evt.preventDefault();
		const { path, subpath } = parseLinktext(linktext);
		// href="#" is a plugin's button, not a link.
		if (!path && subpath.length <= 1) return;
		if (!path) {
			// A link within the rendered text scrolls to its heading.
			const name = stripHeading(subpath.split("#").filter(Boolean).pop() ?? "").toLowerCase();
			const root = target.closest(".markdown-preview-view, .markdown-rendered") ?? this.containerEl;
			const heading = root.findAll("[data-heading]").find((h) => stripHeading(h.getAttribute("data-heading")!).toLowerCase() === name);
			if (heading) return heading.scrollIntoView({ block: "start" });
			if (!this.app.vault.getFileByPath(sourcePath)) return;
		}
		this.app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(evt));
	}

	onExternalLinkClick(evt: MouseEvent, _target: HTMLElement, href: string) {
		evt.preventDefault();
		if (/^\s*(?:javascript|vbscript|data):/i.test(href)) return;
		// The main process hands new windows to the system browser.
		window.open(href, "_blank");
	}

	onTagClick(evt: MouseEvent, _target: HTMLElement, tag: string) {
		evt.preventDefault();
		const search = (this.app as any).internalPlugins?.getPluginById?.("global-search")?.instance;
		if (search?.openGlobalSearch) return search.openGlobalSearch(`tag:${tag}`);
		// justnotes' search view matches text; the tag itself finds it.
		const leaf = this.app.workspace.getLeavesOfType("search")[0];
		const input: HTMLInputElement | undefined = (leaf?.view as any)?.inputEl;
		if (!leaf || !input) return;
		this.app.workspace.revealLeaf(leaf);
		input.value = tag;
		input.dispatchEvent(new Event("input"));
	}

	onFootnoteLinkClick(evt: MouseEvent, target: HTMLElement, id: string) {
		evt.preventDefault();
		target.ownerDocument.getElementById(id)?.scrollIntoView({ block: "center" });
	}

	// `line` is the task's line in this.file, known only where the rendered
	// text is the file (the reading view); there the click toggles the task.
	onCheckboxClick(_evt: MouseEvent, _target: HTMLInputElement, line: number | null) {
		const file = this.file;
		if (line === null || !file) return;
		this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)\]/.exec(lines[line] ?? "");
			if (!m) return data;
			lines[line] = m[1] + (m[2] === " " ? "x" : " ") + lines[line].slice(m[1].length + 1);
			return lines.join("\n");
		});
	}

	onInternalLinkMouseover(evt: MouseEvent, target: HTMLElement, linktext: string, sourcePath: string) {
		this.app.workspace.trigger("hover-link", { event: evt, source: "preview", hoverParent: this, targetEl: target, linktext, sourcePath });
	}

	onInternalLinkContextMenu(evt: MouseEvent, _target: HTMLElement, linktext: string, sourcePath: string) {
		evt.preventDefault();
		const open = (newLeaf: "tab" | "split") => this.app.workspace.openLinkText(linktext, sourcePath, newLeaf);
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Open in new tab").setIcon("lucide-file-plus").setSection("open").onClick(() => open("tab")));
		menu.addItem((i) => i.setTitle("Open to the right").setIcon("lucide-separator-vertical").setSection("open").onClick(() => open("split")));
		const file = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(linktext), sourcePath);
		if (file) this.app.workspace.trigger("file-menu", menu, file, "link-context-menu");
		menu.showAtMouseEvent(evt);
	}

	static render(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component) {
		return renderStatic(app, markdown, el, sourcePath, component, []);
	}

	static renderMarkdown(markdown: string, el: HTMLElement, sourcePath: string, component: Component) {
		return MarkdownRenderer.render(appRef!, markdown, el, sourcePath, component);
	}
}

class StaticRenderer extends MarkdownRenderer {
	#sourcePath: string;

	constructor(app: App, containerEl: HTMLElement, sourcePath: string) {
		super(app, containerEl);
		this.#sourcePath = sourcePath;
	}

	get file() {
		return this.app.vault.getFileByPath(this.#sourcePath);
	}
}

// MarkdownRenderer.render: the blocks go straight into `el` (plugins rely on
// that: `:scope > p`, `> :first-child`), and the post processors run once on
// `el`. getSectionInfo maps each block to its lines in `markdown`.
async function renderStatic(app: App, markdown: string, el: HTMLElement, sourcePath: string, component: Component, embedStack: string[]) {
	// Some plugins pass no component; the output then has no owner to unload it.
	const owner = new StaticRenderer(app, el, sourcePath);
	component?.addChild(owner);
	attachHandlers(owner, el, () => sourcePath, false);
	const env = createEnv(app, sourcePath, randomId());
	const tokens = md.parse(markdown, env);
	await loadLibrariesFor(tokens, markdown, env);
	const job: RenderJob = { app, owner, parent: owner, sourcePath, embedStack, promises: [] };
	const added: HTMLElement[] = [];
	for (const section of toSections(markdown, tokens, env, breaksFor(app))) {
		if (!section.html) continue;
		const frag = toDom(section.html, app, sourcePath);
		const info = { text: markdown, lineStart: section.lineStart, lineEnd: section.lineEnd };
		for (const node of Array.from(frag.children) as HTMLElement[]) {
			sectionInfo.set(node, info);
			added.push(node);
		}
		el.appendChild(frag);
	}
	for (const node of added) enhance(node, job);
	runPostProcessors(el, postProcessorContext(job, env.docId, parseFrontmatter(env), el, el), job.promises);
	await Promise.all(job.promises);
	await finishRenderMath();
}

// ---------------------------------------------------------------------------

interface PreviewSection extends MarkdownRenderedSection {
	el: HTMLElement | null;
	info: MarkdownSectionInformation;
	// Owns what this section's post processors and embeds added; unloaded
	// when the section is re-rendered or removed.
	component: Component;
}

export class MarkdownPreviewRenderer {
	// The handler of each language with a code-block processor (the latest
	// registration wins), for Live Preview's code-block widgets.
	static codeBlockPostProcessors: Record<string, CodeBlockHandler> = {};

	static registerPostProcessor(postProcessor: MarkdownPostProcessor, sortOrder?: number) {
		if (sortOrder !== undefined) postProcessor.sortOrder = sortOrder;
		postProcessors.push(postProcessor);
		postProcessors.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
	}

	static unregisterPostProcessor(postProcessor: MarkdownPostProcessor) {
		removeFrom(postProcessors, postProcessor);
	}

	// Replaces each fenced block of `language` with div.block-language-<language>
	// and hands it to `handler`; the handler's promise joins the render's.
	static createCodeBlockPostProcessor(language: string, handler: CodeBlockHandler) {
		const cls = `language-${language}`;
		return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			const results: Promise<unknown>[] = [];
			for (const code of el.findAll("pre > code")) {
				if (!code.classList.contains(cls)) continue;
				const pre = code.parentElement!;
				const div = createDiv(`block-language-${language}`);
				pre.replaceWith(div);
				transferSection(pre, div);
				try {
					const result = handler(code.textContent ?? "", div, ctx);
					if (isPromise(result)) results.push(result.catch((err) => console.error(err)));
				} catch (err) {
					console.error(err);
				}
			}
			return results.length ? Promise.all(results).then(() => {}) : undefined;
		};
	}

	// justnotes: Plugin.registerMarkdownCodeBlockProcessor goes through these,
	// so the post processor runs in sortOrder and Live Preview can look the
	// language up in codeBlockPostProcessors.
	static registerCodeBlockPostProcessor(language: string, handler: CodeBlockHandler, sortOrder?: number) {
		const postProcessor = MarkdownPreviewRenderer.createCodeBlockPostProcessor(language, handler);
		MarkdownPreviewRenderer.registerPostProcessor(postProcessor, sortOrder);
		const list = codeBlockRegistrations.get(language) ?? [];
		list.push({ handler, postProcessor });
		codeBlockRegistrations.set(language, list);
		MarkdownPreviewRenderer.codeBlockPostProcessors[language] = handler;
		return postProcessor;
	}

	static unregisterCodeBlockPostProcessor(language: string, handler?: CodeBlockHandler) {
		const list = codeBlockRegistrations.get(language) ?? [];
		const i = handler ? list.findIndex((r) => r.handler === handler) : list.length - 1;
		if (i < 0) return;
		removeFrom(postProcessors, list.splice(i, 1)[0].postProcessor);
		const top = list[list.length - 1];
		if (top) MarkdownPreviewRenderer.codeBlockPostProcessors[language] = top.handler;
		else delete MarkdownPreviewRenderer.codeBlockPostProcessors[language];
	}

	// An instance renders a whole note into a reading view, one div.el-* per
	// top-level block, and on set() re-renders only the sections whose
	// output changed. `owner` handles the events and owns what sections add.
	owner: MarkdownRenderer;
	previewEl: HTMLElement;
	sizerEl: HTMLElement;
	pusherEl: HTMLElement;
	headerEl: HTMLElement;
	footerEl: HTMLElement;
	sections: PreviewSection[] = [];
	docId = randomId();
	text = "";
	#version = 0;

	constructor(owner: MarkdownRenderer, previewEl: HTMLElement) {
		this.owner = owner;
		this.previewEl = previewEl;
		previewEl.addClasses(["markdown-preview-view", "markdown-rendered"]);
		this.sizerEl = previewEl.createDiv("markdown-preview-sizer markdown-preview-section");
		this.pusherEl = this.sizerEl.createDiv("markdown-preview-pusher");
		this.headerEl = this.sizerEl.createDiv("mod-header mod-ui");
		this.footerEl = this.sizerEl.createDiv("mod-footer");
		attachHandlers(owner, previewEl, () => this.sourcePath, true);
	}

	get sourcePath() {
		return this.owner.file?.path ?? "";
	}

	async set(text: string) {
		const version = ++this.#version;
		const app = this.owner.app;
		const sourcePath = this.sourcePath;
		const env = createEnv(app, sourcePath, this.docId);
		const tokens = md.parse(text, env);
		await loadLibrariesFor(tokens, text, env);
		if (version !== this.#version) return;
		this.text = text;
		const next = toSections(text, tokens, env, breaksFor(app));
		const old = this.sections;
		let head = 0;
		while (head < old.length && head < next.length && old[head].html === next[head].html) head++;
		let tail = 0;
		while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail].html === next[next.length - 1 - tail].html) tail++;
		for (const section of old.slice(head, old.length - tail)) this.#remove(section);
		const kept = (section: PreviewSection, to: MarkdownRenderedSection) => {
			Object.assign(section, { lineStart: to.lineStart, lineEnd: to.lineEnd });
			Object.assign(section.info, { text, lineStart: to.lineStart, lineEnd: to.lineEnd });
			return section;
		};
		const before = old.slice(old.length - tail).find((s) => s.el)?.el ?? this.footerEl;
		const created = next.slice(head, next.length - tail).map((s) => this.#create(s, text, before));
		this.sections = [
			...old.slice(0, head).map((s, i) => kept(s, next[i])),
			...created,
			...old.slice(old.length - tail).map((s, i) => kept(s, next[next.length - tail + i])),
		];
		const frontmatter = parseFrontmatter(env);
		const promises: Promise<unknown>[] = [];
		for (const section of created) {
			if (!section.el) continue;
			// The note itself counts as embedded, so ![[this note]] stops at once.
			const job: RenderJob = { app, owner: this.owner, parent: section.component, sourcePath, embedStack: [sourcePath], promises };
			enhance(section.el, job);
			runPostProcessors(section.el, postProcessorContext(job, this.docId, frontmatter, this.previewEl, section.el), promises);
		}
		await Promise.all(promises);
		await finishRenderMath();
	}

	clear() {
		this.#version++;
		for (const section of this.sections) this.#remove(section);
		this.sections = [];
		this.text = "";
	}

	rerender(full = false) {
		const text = this.text;
		if (full) this.clear();
		return this.set(text);
	}

	getSectionInfo(el: HTMLElement) {
		return sectionInfoOf(el);
	}

	#create(section: MarkdownRenderedSection, text: string, before: HTMLElement): PreviewSection {
		const component = this.owner.addChild(new Component());
		const info = { text, lineStart: section.lineStart, lineEnd: section.lineEnd };
		if (!section.html) return { ...section, el: null, info, component };
		const frag = toDom(section.html, this.owner.app, this.sourcePath);
		const first = frag.firstElementChild;
		const el = createDiv(first?.hasClass("frontmatter") ? "el-pre mod-frontmatter mod-ui" : `el-${first?.tagName.toLowerCase() ?? "div"}`);
		el.appendChild(frag);
		sectionInfo.set(el, info);
		this.sizerEl.insertBefore(el, before);
		return { ...section, el, info, component };
	}

	#remove(section: PreviewSection) {
		this.owner.removeChild(section.component);
		section.el?.remove();
	}
}

MarkdownPreviewRenderer.registerCodeBlockPostProcessor("mermaid", renderMermaidBlock, 1000);
