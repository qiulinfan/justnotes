import * as nodePath from "node:path";
import { Events } from "./events";
import { getAllTags, getLinkpath, locateFrontMatter, parseFrontMatterAliases } from "./metadata-utils";
import { parseYaml } from "./util";
import { type TAbstractFile, TFile, type Vault } from "./vault";

// Line and col are 0-based; col and offset count UTF-16 code units.
export interface Loc {
	line: number;
	col: number;
	offset: number;
}
export interface Pos {
	start: Loc;
	end: Loc;
}
export interface CacheItem {
	position: Pos;
}
export interface Reference {
	link: string;
	original: string;
	displayText?: string;
}
export interface ReferenceCache extends Reference, CacheItem {}
export type LinkCache = ReferenceCache;
export type EmbedCache = ReferenceCache;
export interface FrontmatterLinkCache extends Reference {
	key: string;
}
export interface TagCache extends CacheItem {
	tag: string;
}
export interface HeadingCache extends CacheItem {
	heading: string;
	level: number;
}
export interface SectionCache extends CacheItem {
	type: string;
	id?: string;
}
export interface ListItemCache extends CacheItem {
	parent: number;
	task?: string;
	id?: string;
}
export interface BlockCache extends CacheItem {
	id: string;
}
export interface FootnoteCache extends CacheItem {
	id: string;
}
export interface FootnoteRefCache extends CacheItem {
	id: string;
}
export interface ReferenceLinkCache extends CacheItem {
	id: string;
	link: string;
}

export interface CachedMetadata {
	frontmatter?: Record<string, any>;
	frontmatterPosition?: Pos;
	frontmatterLinks?: FrontmatterLinkCache[];
	headings?: HeadingCache[];
	links?: LinkCache[];
	embeds?: EmbedCache[];
	tags?: TagCache[];
	sections?: SectionCache[];
	listItems?: ListItemCache[];
	blocks?: Record<string, BlockCache>;
	footnotes?: FootnoteCache[];
	footnoteRefs?: FootnoteRefCache[];
	referenceLinks?: ReferenceLinkCache[];
}

export interface HeadingSubpathResult {
	type: "heading";
	current: HeadingCache;
	next: HeadingCache;
	start: Loc;
	end: Loc | null;
}
export interface BlockSubpathResult {
	type: "block";
	block: BlockCache;
	list?: ListItemCache;
	start: Loc;
	end: Loc | null;
}
export interface FootnoteSubpathResult {
	type: "footnote";
	footnote: FootnoteCache;
	start: Loc;
	end: Loc | null;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])(?=[ \t]|$)([ \t]*)/;
const QUOTE = /^ {0,3}>/;
const QUOTE_PREFIX = /^(?: {0,3}> ?)+/;
const CALLOUT = /^ {0,3}>\s*\[!([^\]]+)\]/;
const FOOTNOTE_DEF = /^ {0,3}\[\^([^\]\s]+)\]:/;
const REF_DEF = /^ {0,3}\[([^\]^][^\]]*)\]:[ \t]*(<[^>\n]*>|\S+)/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
// CommonMark HTML blocks: a block-level tag, or any complete tag alone on its line.
const HTML_BLOCK =
	/^ {0,3}<\/?(?:address|article|aside|blockquote|body|caption|center|colgroup|dd|details|dialog|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|iframe|li|main|menu|nav|ol|p|pre|script|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|tr|ul)(?=[\s/>]|$)/i;
const HTML_TAG_LINE = /^ {0,3}<\/?[a-zA-Z][\w-]*(?:\s+[^<>]*)?\/?>\s*$/;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/;
const STANDALONE_ID = /^ {0,3}\^([A-Za-z0-9-]+)[ \t]*$/;
const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g;
// [text](dest "title"), dest possibly in <...>, one level of nesting in both.
const MDLINK = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^<>\n]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;
const TAG = /(?<=^|\s)#([\p{L}\p{N}\p{M}\p{Extended_Pictographic}_\-/‍️]+)/gu;
const FOOTNOTE_REF = /\[\^([^\]\s]+)\](?!:)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

const blank = (s: string) => !s.trim();
const indentOf = (s: string) => s.length - s.trimStart().length;
const blankOut = (s: string) => " ".repeat(s.length);

function safeDecode(s: string) {
	try {
		return decodeURI(s);
	} catch {
		return s;
	}
}

// Blanks code spans, math, comments and escapes in one line, keeping offsets,
// so their contents are not read as links or tags. `state` carries a %% or
// <!-- comment that is still open from an earlier line of the same block.
function maskInline(line: string, state: { comment: string | null }) {
	let out = "";
	let i = 0;
	while (i < line.length) {
		if (state.comment) {
			const close = line.indexOf(state.comment === "%%" ? "%%" : "-->", i);
			const end = close < 0 ? line.length : close + (state.comment === "%%" ? 2 : 3);
			out += blankOut(line.slice(i, end));
			if (close >= 0) state.comment = null;
			i = end;
			continue;
		}
		const c = line[i];
		if (c === "\\" && i + 1 < line.length) {
			// The escaped character keeps no special meaning; a tag after '\' is
			// already no tag, and Windows paths in links stay intact.
			out += line.slice(i, i + 2);
			i += 2;
		} else if (c === "`") {
			let n = 1;
			while (line[i + n] === "`") n++;
			const run = "`".repeat(n);
			let close = line.indexOf(run, i + n);
			while (close >= 0 && line[close + n] === "`") close = line.indexOf(run, close + n + 1);
			if (close < 0) {
				out += line.slice(i, i + n);
				i += n;
			} else {
				out += blankOut(line.slice(i, close + n));
				i = close + n;
			}
		} else if (line.startsWith("%%", i)) {
			state.comment = "%%";
			out += "  ";
			i += 2;
		} else if (line.startsWith("<!--", i)) {
			state.comment = "<!--";
			out += "    ";
			i += 4;
		} else if (c === "$") {
			const m = /^\$\$[^$]+\$\$|^\$(?=[^\s$])[^$]*?[^\s$\\]\$(?!\d)|^\$[^\s$]\$(?!\d)/.exec(line.slice(i));
			if (m) {
				out += blankOut(m[0]);
				i += m[0].length;
			} else {
				out += c;
				i++;
			}
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

interface Line {
	start: number;
	text: string;
}

function splitLines(text: string): Line[] {
	const lines: Line[] = [];
	let start = 0;
	for (;;) {
		const nl = text.indexOf("\n", start);
		const raw = nl < 0 ? text.slice(start) : text.slice(start, nl);
		lines.push({ start, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
		if (nl < 0) return lines;
		start = nl + 1;
	}
}

// Wikilinks inside frontmatter string values, keyed by property ('key.0' for
// list entries).
function frontmatterLinks(value: unknown, key: string, out: FrontmatterLinkCache[]) {
	if (typeof value === "string") {
		for (const m of value.matchAll(WIKILINK)) {
			if (m[1]) continue;
			const { link, alias } = splitWikilink(m[2]);
			out.push({ key, link, original: m[0], displayText: alias ?? wikiDisplay(link) });
		}
	} else if (Array.isArray(value)) value.forEach((v, i) => frontmatterLinks(v, `${key}.${i}`, out));
	else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) frontmatterLinks(v, key ? `${key}.${k}` : k, out);
}

// 'path#sub|alias'; inside tables the pipe is escaped as '\|'.
function splitWikilink(inner: string) {
	const m = /^(.*?)\\?\|([\s\S]*)$/.exec(inner);
	return m ? { link: m[1].trim(), alias: m[2] } : { link: inner.trim(), alias: undefined };
}

// Obsidian shows [[note#heading]] as 'note > heading'.
function wikiDisplay(link: string) {
	return link
		.split("#")
		.filter(Boolean)
		.join(" > ");
}

// A line-based CommonMark block segmenter that yields Obsidian's cache:
// root-level sections, headings, list items with their parents, block ids,
// links, embeds, tags and footnotes. Code, math, comments and HTML are skipped
// for links and tags.
export function parseMetadata(text: string): CachedMetadata {
	const lines = splitLines(text);
	const lineAt = (offset: number) => {
		let lo = 0;
		let hi = lines.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lines[mid].start <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
	const loc = (offset: number): Loc => {
		const line = lineAt(offset);
		return { line, col: offset - lines[line].start, offset };
	};
	const pos = (s: number, e: number): Pos => ({ start: loc(s), end: loc(e) });
	const lineEnd = (i: number) => lines[i].start + lines[i].text.length;
	// A block spans from the first non-blank character of its first line to the end of its last.
	const span = (first: number, last: number, col = indentOf(lines[first].text)): Pos => pos(lines[first].start + col, lineEnd(last));

	const cache: CachedMetadata = {};
	const sections: SectionCache[] = [];
	const headings: HeadingCache[] = [];
	const links: LinkCache[] = [];
	const embeds: EmbedCache[] = [];
	const tags: TagCache[] = [];
	const listItems: ListItemCache[] = [];
	const blocks: Record<string, BlockCache> = {};
	const footnotes: FootnoteCache[] = [];
	const footnoteRefs: FootnoteRefCache[] = [];
	const referenceLinks: ReferenceLinkCache[] = [];

	let first = 0;
	const fm = locateFrontMatter(text);
	if (fm) {
		const position = pos(0, fm.end);
		cache.frontmatterPosition = position;
		sections.push({ type: "yaml", position });
		try {
			const data = parseYaml(text.slice(fm.from, fm.to));
			if (data && typeof data === "object" && !Array.isArray(data)) {
				cache.frontmatter = data;
				const found: FrontmatterLinkCache[] = [];
				frontmatterLinks(data, "", found);
				if (found.length) cache.frontmatterLinks = found;
			}
		} catch {}
		first = position.end.line + 1;
	}

	// Links, tags and footnote references in one line of inline content.
	const scanInline = (i: number, masked: string) => {
		const base = lines[i].start;
		const raw = lines[i].text;
		let tagText = masked;
		for (const m of masked.matchAll(WIKILINK)) {
			const s = base + m.index!;
			const original = raw.slice(m.index!, m.index! + m[0].length);
			const { link, alias } = splitWikilink(original.slice(m[1].length + 2, -2));
			(m[1] ? embeds : links).push({ link, original, displayText: alias ?? wikiDisplay(link), position: pos(s, s + m[0].length) });
			tagText = tagText.slice(0, m.index!) + blankOut(m[0]) + tagText.slice(m.index! + m[0].length);
		}
		for (const hit of masked.matchAll(MDLINK)) {
			const s = base + hit.index!;
			const original = raw.slice(hit.index!, hit.index! + hit[0].length);
			// The groups come from the unmasked text, so '$' or '`' in a path survive.
			const unmasked = new RegExp(MDLINK.source).exec(original);
			const m = unmasked && unmasked.index === 0 && unmasked[0].length === original.length ? unmasked : hit;
			const dest = m[3].startsWith("<") ? m[3].slice(1, -1) : m[3];
			if (!dest || SCHEME.test(dest)) continue;
			(m[1] ? embeds : links).push({ link: safeDecode(dest), original, displayText: m[2], position: pos(s, s + m[0].length) });
			const destAt = hit.index! + hit[0].indexOf("](") + 1;
			tagText = tagText.slice(0, destAt) + blankOut(hit[0].slice(destAt - hit.index!)) + tagText.slice(hit.index! + hit[0].length);
		}
		for (const m of tagText.matchAll(TAG)) {
			if (/^[\d/]+$/.test(m[1])) continue;
			const s = base + m.index!;
			tags.push({ tag: `#${m[1]}`, position: pos(s, s + m[0].length) });
		}
		for (const m of masked.matchAll(FOOTNOTE_REF)) {
			const s = base + m.index!;
			footnoteRefs.push({ id: m[1], position: pos(s, s + m[0].length) });
		}
	};

	// Inline-scans lines [from, to], blanking a prefix of each (quote markers,
	// a footnote label) and skipping fenced code nested in the block.
	const scanBlock = (from: number, to: number, prefix?: (i: number) => number) => {
		const state = { comment: null as string | null };
		let fence: string | null = null;
		const masked: string[] = [];
		for (let i = from; i <= to; i++) {
			const cut = prefix ? prefix(i) : 0;
			const body = lines[i].text.slice(cut);
			const f = /^\s*(`{3,}|~{3,})/.exec(body);
			if (fence) {
				if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
				masked.push(blankOut(lines[i].text));
				continue;
			}
			if (f && i > from) {
				fence = f[1];
				masked.push(blankOut(lines[i].text));
				continue;
			}
			const line = blankOut(lines[i].text.slice(0, cut)) + maskInline(body, state);
			masked.push(line);
			scanInline(i, line);
		}
		return masked;
	};

	const addBlock = (id: string, position: Pos) => {
		blocks[id.toLowerCase()] = { id, position };
	};
	// A trailing ' ^id' on the block's last line names the block.
	const trailingId = (masked: string) => BLOCK_ID.exec(masked)?.[1];

	const paragraphInterrupt = (s: string) => {
		if (ATX.test(s) || FENCE.test(s) || QUOTE.test(s) || /^\s*\$\$/.test(s) || /^\s*%%/.test(s)) return true;
		if (HR.test(s) && !SETEXT.test(s)) return true;
		const li = LIST.exec(s);
		return !!li && !blank(s.slice(li[0].length)) && (!/\d/.test(li[2]) || /^1[.)]$/.test(li[2]));
	};
	// Lazy continuation: a non-blank line that does not open a block of its own.
	const lazy = (s: string) => !blank(s) && !ATX.test(s) && !FENCE.test(s) && !HR.test(s) && !QUOTE.test(s) && !LIST.test(s);

	// List items of lines [from, to], whose own text starts at col offset cut(i).
	const scanList = (from: number, to: number, cut: (i: number) => number) => {
		const stack: { content: number; line: number }[] = [];
		let listStart = -1;
		let current: ListItemCache | null = null;
		let lastLine = from;
		const finish = () => {
			if (!current) return;
			current.position.end = loc(lineEnd(lastLine));
			const id = trailingId(lines[lastLine].text.slice(cut(lastLine)));
			if (id) {
				current.id = id;
				addBlock(id, current.position);
			}
		};
		let fence: string | null = null;
		let afterBlank = false;
		for (let i = from; i <= to; i++) {
			const c = cut(i);
			const body = lines[i].text.slice(c);
			const f = /^\s*(`{3,}|~{3,})/.exec(body);
			if (fence) {
				if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
				lastLine = i;
				continue;
			}
			const li = f ? null : LIST.exec(body);
			if (f) fence = f[1];
			if (!li || HR.test(body)) {
				if (blank(body)) afterBlank = true;
				else if (afterBlank && indentOf(body) < 2) {
					// A paragraph after a blank line ends the list (inside a quote).
					finish();
					current = null;
					stack.length = 0;
					listStart = -1;
				} else lastLine = i;
				if (!blank(body)) afterBlank = false;
				continue;
			}
			afterBlank = false;
			finish();
			if (listStart < 0) listStart = i;
			const indent = li[1].replace(/\t/g, "    ").length;
			while (stack.length && indent < stack[stack.length - 1].content) stack.pop();
			const parent = stack.length ? stack[stack.length - 1].line : -listStart;
			const content = indent + li[2].length + Math.max(1, Math.min(li[3].length, 4));
			stack.push({ content, line: i });
			const start = lines[i].start + c + li[1].length;
			current = { parent, position: pos(start, lineEnd(i)) };
			const task = /^\[(.)\](?=\s|$)/.exec(body.slice(li[0].length));
			if (task) current.task = task[1];
			listItems.push(current);
			lastLine = i;
		}
		finish();
	};

	let i = first;
	while (i < lines.length) {
		const line = lines[i].text;
		if (blank(line)) {
			i++;
			continue;
		}
		let end = i;
		if (/^(?: {4}| {0,3}\t)/.test(line)) {
			// An indented code block runs while lines stay indented or blank.
			for (let k = i + 1; k < lines.length; k++) {
				if (blank(lines[k].text)) continue;
				if (!/^(?: {4}| {0,3}\t)/.test(lines[k].text)) break;
				end = k;
			}
			sections.push({ type: "code", position: span(i, end) });
			i = end + 1;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const marker = fence[1];
			const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
			while (end + 1 < lines.length && !close.test(lines[end + 1].text)) end++;
			if (end + 1 < lines.length) end++;
			sections.push({ type: "code", position: span(i, end) });
			i = end + 1;
			continue;
		}
		const delimited = (open: RegExp, mark: string, type: string) => {
			const m = open.exec(line);
			if (!m) return false;
			if (!line.slice(m.index + m[0].length).includes(mark)) {
				while (end + 1 < lines.length && !lines[end + 1].text.includes(mark)) end++;
				if (end + 1 < lines.length) end++;
			}
			sections.push({ type, position: span(i, end) });
			return true;
		};
		if (delimited(/^\s*\$\$/, "$$", "math") || delimited(/^\s*%%/, "%%", "comment") || delimited(/^ {0,3}<!--/, "-->", "html")) {
			i = end + 1;
			continue;
		}
		if (HTML_BLOCK.test(line) || HTML_TAG_LINE.test(line)) {
			while (end + 1 < lines.length && !blank(lines[end + 1].text)) end++;
			sections.push({ type: "html", position: span(i, end) });
			i = end + 1;
			continue;
		}
		const atx = ATX.exec(line);
		if (atx) {
			const position = span(i, i);
			headings.push({ heading: atx[2] ?? "", level: atx[1].length, position });
			sections.push({ type: "heading", position });
			scanBlock(i, i);
			i++;
			continue;
		}
		if (HR.test(line)) {
			sections.push({ type: "thematicBreak", position: span(i, i) });
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			while (end + 1 < lines.length && (QUOTE.test(lines[end + 1].text) || lazy(lines[end + 1].text))) end++;
			const cut = (k: number) => QUOTE_PREFIX.exec(lines[k].text)?.[0].length ?? 0;
			const masked = scanBlock(i, end, cut);
			scanList(i, end, cut);
			const position = span(i, end);
			const section: SectionCache = { type: CALLOUT.test(line) ? "callout" : "blockquote", position };
			const id = trailingId(masked[masked.length - 1]);
			if (id) {
				section.id = id;
				addBlock(id, position);
			}
			sections.push(section);
			i = end + 1;
			continue;
		}
		const item = LIST.exec(line);
		if (item) {
			// A root item with another kind of marker starts a new list.
			const kind = (m: RegExpExecArray) => (/\d/.test(m[2]) ? m[2].slice(-1) : m[2]);
			const rootIndent = item[1].length + item[2].length + 1;
			const sameList = (s: string) => {
				const m = LIST.exec(s);
				return !!m && (m[1].length >= rootIndent || kind(m) === kind(item));
			};
			for (let k = i + 1; k < lines.length; k++) {
				const next = lines[k].text;
				if (!blank(next)) {
					if (HR.test(next) || (LIST.test(next) && !sameList(next))) break;
					if (LIST.test(next) || indentOf(next) >= 2 || /^\t/.test(next) || (k === end + 1 && lazy(next))) {
						end = k;
						continue;
					}
					break;
				}
				let a = k + 1;
				while (a < lines.length && blank(lines[a].text)) a++;
				const after = lines[a]?.text;
				if (after === undefined || !(sameList(after) || indentOf(after) >= 2 || /^\t/.test(after))) break;
				k = a - 1;
			}
			scanBlock(i, end);
			scanList(i, end, () => 0);
			sections.push({ type: "list", position: span(i, end) });
			i = end + 1;
			continue;
		}
		const footnote = FOOTNOTE_DEF.exec(line);
		if (footnote) {
			const continues = (s: string) => !blank(s) && !FOOTNOTE_DEF.test(s) && !REF_DEF.test(s) && (indentOf(s) > 0 || lazy(s));
			while (end + 1 < lines.length && continues(lines[end + 1].text)) end++;
			const position = span(i, end);
			scanBlock(i, end, (k) => (k === i ? footnote[0].length : 0));
			footnotes.push({ id: footnote[1], position });
			sections.push({ type: "footnoteDefinition", position });
			i = end + 1;
			continue;
		}
		const ref = REF_DEF.exec(line);
		if (ref) {
			const link = ref[2].startsWith("<") ? ref[2].slice(1, -1) : ref[2];
			const position = span(i, i);
			referenceLinks.push({ id: ref[1], link, position });
			sections.push({ type: "definition", position });
			i++;
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && lines[i + 1].text.includes("|") && TABLE_DELIM.test(lines[i + 1].text)) {
			end = i + 1;
			while (end + 1 < lines.length && !blank(lines[end + 1].text) && lines[end + 1].text.includes("|")) end++;
			scanBlock(i, end);
			sections.push({ type: "table", position: span(i, end) });
			i = end + 1;
			continue;
		}
		const standalone = STANDALONE_ID.exec(line);
		const previous = sections[sections.length - 1];
		if (standalone && (i + 1 >= lines.length || blank(lines[i + 1].text)) && previous && previous.type !== "yaml" && previous.type !== "heading") {
			previous.id = standalone[1];
			addBlock(standalone[1], previous.position);
			i++;
			continue;
		}
		// A paragraph, or a setext heading when an underline ends it.
		let setext: RegExpExecArray | null = null;
		while (end + 1 < lines.length) {
			const next = lines[end + 1].text;
			if (blank(next)) break;
			setext = SETEXT.exec(next);
			if (setext || paragraphInterrupt(next)) break;
			end++;
		}
		if (setext) {
			const position = span(i, end + 1);
			const heading = lines
				.slice(i, end + 1)
				.map((l) => l.text.trim())
				.join(" ");
			headings.push({ heading, level: setext[1][0] === "=" ? 1 : 2, position });
			sections.push({ type: "heading", position });
			scanBlock(i, end);
			i = end + 2;
			continue;
		}
		const masked = scanBlock(i, end);
		const position = span(i, end);
		const section: SectionCache = { type: "paragraph", position };
		const id = trailingId(masked[masked.length - 1]);
		if (id) {
			section.id = id;
			addBlock(id, position);
		}
		sections.push(section);
		i = end + 1;
	}

	const byOffset = (a: CacheItem, b: CacheItem) => a.position.start.offset - b.position.start.offset;
	links.sort(byOffset);
	embeds.sort(byOffset);
	tags.sort(byOffset);
	listItems.sort(byOffset);
	if (headings.length) cache.headings = headings;
	if (links.length) cache.links = links;
	if (embeds.length) cache.embeds = embeds;
	if (tags.length) cache.tags = tags;
	if (listItems.length) cache.listItems = listItems;
	if (sections.length) cache.sections = sections;
	if (Object.keys(blocks).length) cache.blocks = blocks;
	if (footnotes.length) cache.footnotes = footnotes;
	if (footnoteRefs.length) cache.footnoteRefs = footnoteRefs;
	if (referenceLinks.length) cache.referenceLinks = referenceLinks;
	return cache;
}

// Obsidian's private multi-map: lowercased file name to the files with that name.
class CustomArrayDict<T> {
	data = new Map<string, T[]>();

	get(key: string) {
		return this.data.get(key) ?? null;
	}

	add(key: string, value: T) {
		const list = this.data.get(key);
		if (!list) this.data.set(key, [value]);
		else if (!list.includes(value)) list.push(value);
	}

	remove(key: string, value: T) {
		const list = this.data.get(key);
		if (!list) return;
		const i = list.indexOf(value);
		if (i >= 0) list.splice(i, 1);
		if (!list.length) this.data.delete(key);
	}

	contains(key: string, value: T) {
		return !!this.data.get(key)?.includes(value);
	}

	keys() {
		return [...this.data.keys()];
	}

	count() {
		let n = 0;
		for (const list of this.data.values()) n += list.length;
		return n;
	}

	clear(key: string) {
		this.data.delete(key);
	}

	clearAll() {
		this.data.clear();
	}
}

const nameKey = (path: string) => nodePath.posix.basename(path).toLowerCase();

// Everything is derived in memory: initialize() parses every note once at
// startup, then vault events keep the cache, the link maps and their reverse
// indexes current. Resolution is incremental: a create, delete or rename
// re-resolves only the notes whose links it can change, each firing 'resolve',
// and one 'resolved' follows once the batch is done.
export class MetadataCache extends Events {
	vault: Vault;
	resolvedLinks: Record<string, Record<string, number>> = {};
	unresolvedLinks: Record<string, Record<string, number>> = {};
	resolved = false;
	uniqueFileLookup = new CustomArrayDict<TFile>();
	#namesReady = false;
	#cache = new Map<string, CachedMetadata>();
	// Destination path to the notes that resolve a link to it.
	#backlinks = new Map<string, Set<string>>();
	// Lowercased name of an unresolved linkpath to the notes that hold it.
	#unresolvedBy = new Map<string, Set<string>>();
	#generation = new WeakMap<TFile, number>();
	#pending = new Set<TFile>();
	#flushQueued = false;
	#dirty = false;
	#inflight = 0;
	#initializing: Promise<void> | null = null;
	#onClean: (() => void)[] = [];

	constructor(vault: Vault) {
		super();
		this.vault = vault;
		// Registered before any plugin, so 'deleted' runs before plugins' vault 'delete' handlers.
		vault.on("create", (f: TAbstractFile) => f instanceof TFile && this.#onCreate(f));
		vault.on("modify", (f: TAbstractFile) => f instanceof TFile && f.extension === "md" && this.#index(f));
		vault.on("delete", (f: TAbstractFile) => f instanceof TFile && this.#onDelete(f));
		vault.on("rename", (f: TAbstractFile, oldPath: string) => f instanceof TFile && this.#onRename(f, oldPath));
	}

	// Parses every note, resolves every link, then fires 'resolved'. Awaitable,
	// so the host can have the cache ready before plugins load.
	initialize() {
		this.#initializing ??= this.#initialIndex();
		return this.#initializing;
	}

	async #initialIndex() {
		this.#buildNames();
		const files = this.vault.getMarkdownFiles();
		for (let i = 0; i < files.length; i += 50) await Promise.all(files.slice(i, i + 50).map((f) => this.#index(f)));
		this.#flush();
		this.resolved = true;
		this.trigger("resolved");
		for (const cb of this.#onClean.splice(0)) cb();
	}

	#buildNames() {
		this.uniqueFileLookup.clearAll();
		for (const f of this.vault.getFiles()) this.uniqueFileLookup.add(f.name.toLowerCase(), f);
		this.#namesReady = true;
	}

	#names() {
		if (!this.#namesReady) this.#buildNames();
		return this.uniqueFileLookup;
	}

	// While notes are being read, resolution waits, so one change gives one 'resolved'.
	async #index(file: TFile) {
		const generation = (this.#generation.get(file) ?? 0) + 1;
		this.#generation.set(file, generation);
		this.#inflight++;
		try {
			const text = await this.vault.cachedRead(file);
			if (this.#generation.get(file) !== generation || this.vault.getAbstractFileByPath(file.path) !== file) return;
			const cache = parseMetadata(text);
			this.#cache.set(file.path, cache);
			this.trigger("changed", file, text, cache);
			this.#queue(file);
		} catch {
		} finally {
			this.#inflight--;
			if (!this.#inflight && this.#dirty) this.#scheduleFlush();
		}
	}

	#onCreate(file: TFile) {
		this.#names().add(file.name.toLowerCase(), file);
		this.#appeared(file);
		if (file.extension === "md") this.#index(file);
		this.#scheduleFlush();
	}

	// Notes whose links can now resolve to this file: unresolved links naming
	// it, and links that resolved to another file of the same name.
	#appeared(file: TFile) {
		const keys = [file.name.toLowerCase()];
		if (file.extension === "md") keys.push(file.basename.toLowerCase());
		for (const k of keys) for (const src of this.#unresolvedBy.get(k) ?? []) this.#queuePath(src);
		for (const other of this.#names().get(file.name.toLowerCase()) ?? []) {
			if (other !== file) for (const src of this.#backlinks.get(other.path) ?? []) this.#queuePath(src);
		}
	}

	#onDelete(file: TFile) {
		this.#names().remove(file.name.toLowerCase(), file);
		const prev = this.#cache.get(file.path) ?? null;
		this.#cache.delete(file.path);
		this.#setLinks(file.path, null, null);
		for (const src of this.#backlinks.get(file.path) ?? []) this.#queuePath(src);
		if (file.extension === "md") this.trigger("deleted", file, prev);
		this.#scheduleFlush();
	}

	#onRename(file: TFile, oldPath: string) {
		this.#names().remove(nameKey(oldPath), file);
		this.#names().add(file.name.toLowerCase(), file);
		const cache = this.#cache.get(oldPath);
		this.#cache.delete(oldPath);
		if (cache) this.#cache.set(file.path, cache);
		// Its own links move with it; links to it follow it at once and are re-resolved.
		const resolved = this.resolvedLinks[oldPath] ?? null;
		const unresolved = this.unresolvedLinks[oldPath] ?? null;
		this.#setLinks(oldPath, null, null);
		if (resolved || unresolved) this.#setLinks(file.path, resolved ?? {}, unresolved ?? {});
		for (const src of [...(this.#backlinks.get(oldPath) ?? [])]) {
			const counts = this.resolvedLinks[src];
			if (!counts || !(oldPath in counts)) continue;
			const moved = { ...counts, [file.path]: (counts[file.path] ?? 0) + counts[oldPath] };
			delete moved[oldPath];
			this.#setLinks(src, moved, this.unresolvedLinks[src] ?? {});
			this.#queuePath(src);
		}
		if (file.extension === "md") this.#queue(file);
		this.#appeared(file);
		this.#scheduleFlush();
	}

	#queuePath(path: string) {
		const file = this.vault.getFileByPath(path);
		if (file) this.#queue(file);
	}

	#queue(file: TFile) {
		this.#pending.add(file);
		this.#scheduleFlush();
	}

	#scheduleFlush() {
		this.#dirty = true;
		if (this.#flushQueued) return;
		this.#flushQueued = true;
		queueMicrotask(() => this.#flush());
	}

	#flush() {
		this.#flushQueued = false;
		if (!this.#dirty || this.#inflight) return;
		this.#dirty = false;
		const files = [...this.#pending];
		this.#pending.clear();
		for (const file of files) {
			if (this.vault.getAbstractFileByPath(file.path) !== file || !this.#cache.has(file.path)) continue;
			this.#resolve(file);
			this.trigger("resolve", file);
		}
		if (this.resolved) this.trigger("resolved");
	}

	#resolve(file: TFile) {
		const resolved: Record<string, number> = {};
		const unresolved: Record<string, number> = {};
		for (const ref of this.#refs(this.#cache.get(file.path))) {
			const linkpath = getLinkpath(ref.link);
			const dest = this.getFirstLinkpathDest(linkpath, file.path);
			if (dest) resolved[dest.path] = (resolved[dest.path] ?? 0) + 1;
			else if (linkpath) unresolved[linkpath] = (unresolved[linkpath] ?? 0) + 1;
		}
		this.#setLinks(file.path, resolved, unresolved);
	}

	#refs(cache: CachedMetadata | undefined): Reference[] {
		return [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])];
	}

	// Replaces one note's link maps and keeps the reverse indexes in step.
	#setLinks(src: string, resolved: Record<string, number> | null, unresolved: Record<string, number> | null) {
		for (const dest of Object.keys(this.resolvedLinks[src] ?? {})) this.#unlinkFrom(this.#backlinks, dest, src);
		for (const link of Object.keys(this.unresolvedLinks[src] ?? {})) this.#unlinkFrom(this.#unresolvedBy, nameKey(link), src);
		if (!resolved || !unresolved) {
			delete this.resolvedLinks[src];
			delete this.unresolvedLinks[src];
			return;
		}
		this.resolvedLinks[src] = resolved;
		this.unresolvedLinks[src] = unresolved;
		for (const dest of Object.keys(resolved)) this.#linkTo(this.#backlinks, dest, src);
		for (const link of Object.keys(unresolved)) this.#linkTo(this.#unresolvedBy, nameKey(link), src);
	}

	#linkTo(index: Map<string, Set<string>>, key: string, src: string) {
		let set = index.get(key);
		if (!set) index.set(key, (set = new Set()));
		set.add(src);
	}

	#unlinkFrom(index: Map<string, Set<string>>, key: string, src: string) {
		const set = index.get(key);
		if (!set) return;
		set.delete(src);
		if (!set.size) index.delete(key);
	}

	getFileCache(file: TFile) {
		return this.#cache.get(file.path) ?? null;
	}

	getCache(path: string) {
		return this.#cache.get(path) ?? null;
	}

	getCachedFiles() {
		return [...this.#cache.keys()];
	}

	// Obsidian's order: relative to the source's folder, then the vault-absolute
	// path, then any file whose path ends with the linkpath, nearest and
	// shortest first. Names match without regard to case, and a linkpath is
	// also tried with '.md' appended, whatever dots it already has.
	getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
		return this.getLinkpathDest(linkpath, sourcePath)[0] ?? null;
	}

	getLinkpathDest(linkpath: string, sourcePath: string): TFile[] {
		if (!linkpath) {
			const self = this.vault.getFileByPath(sourcePath);
			return self ? [self] : [];
		}
		const absolute = linkpath.startsWith("/");
		const path = linkpath.replace(/^\/+/, "");
		const names = /\.md$/i.test(path) ? [path] : [path, `${path}.md`];
		const out: TFile[] = [];
		const add = (f: TAbstractFile | null) => {
			if (f instanceof TFile && !out.includes(f)) out.push(f);
		};
		const dir = nodePath.posix.dirname(sourcePath);
		if (!absolute && dir !== ".") for (const n of names) add(this.#fileAt(nodePath.posix.join(dir, n)));
		for (const n of names) add(this.#fileAt(nodePath.posix.normalize(n)));
		if (absolute) return out;
		const suffixes = names.map((n) => `/${n.toLowerCase()}`);
		const matches = names
			.flatMap((n) => this.#names().get(nameKey(n)) ?? [])
			.filter((f) => suffixes.some((s) => `/${f.path.toLowerCase()}`.endsWith(s)));
		const near = (f: TFile) => (nodePath.posix.dirname(f.path) === dir ? 0 : 1);
		matches.sort((a, b) => near(a) - near(b) || a.path.length - b.path.length || a.path.localeCompare(b.path));
		for (const f of matches) add(f);
		return out;
	}

	#fileAt(path: string) {
		const file = this.vault.getFileByPath(path);
		return file ?? this.vault.getAbstractFileByPathInsensitive(path);
	}

	// newLinkFormat 'shortest' (the default) gives the bare name when no other
	// file has it, else the vault path; 'relative' and 'absolute' always give a path.
	fileToLinktext(file: TFile, sourcePath: string, omitMdExtension = true) {
		const strip = omitMdExtension && file.extension === "md";
		const full = strip ? file.path.slice(0, -3) : file.path;
		const format = this.vault.getConfig("newLinkFormat");
		if (format === "absolute") return full;
		if (format === "relative") {
			const dir = nodePath.posix.dirname(sourcePath);
			return nodePath.posix.relative(`/${dir === "." ? "" : dir}`, `/${full}`);
		}
		const unique = (this.#names().get(file.name.toLowerCase())?.length ?? 0) <= 1;
		return unique ? (strip ? file.basename : file.name) : full;
	}

	// Body and frontmatter tags of every note, counted per tag; spellings that
	// differ only in case count as one, under the first one seen.
	getTags() {
		const counts: Record<string, number> = {};
		const spelling = new Map<string, string>();
		for (const cache of this.#cache.values()) {
			for (const tag of getAllTags(cache) ?? []) {
				const lower = tag.toLowerCase();
				let name = spelling.get(lower);
				if (!name) spelling.set(lower, (name = tag));
				counts[name] = (counts[name] ?? 0) + 1;
			}
		}
		return counts;
	}

	// Notes linking to the file, with the references that resolve to it.
	getBacklinksForFile(file: TFile) {
		const result = new CustomArrayDict<Reference>();
		for (const src of this.#backlinks.get(file.path) ?? []) {
			for (const ref of this.#refs(this.#cache.get(src))) {
				if (this.getFirstLinkpathDest(getLinkpath(ref.link), src) === file) result.add(src, ref);
			}
		}
		return result;
	}

	getLinks() {
		const out: Record<string, ReferenceCache[]> = {};
		for (const [path, cache] of this.#cache) if (cache.links?.length) out[path] = [...cache.links];
		return out;
	}

	// Every file, each alias of a note, and every unresolved link target.
	getLinkSuggestions() {
		const out: { file: TFile | null; path: string; alias?: string }[] = [];
		for (const file of this.vault.getFiles()) {
			out.push({ file, path: file.path });
			for (const alias of parseFrontMatterAliases(this.#cache.get(file.path)?.frontmatter) ?? []) out.push({ file, path: file.path, alias });
		}
		const unresolved = new Set<string>();
		for (const links of Object.values(this.unresolvedLinks)) for (const link of Object.keys(links)) unresolved.add(link);
		for (const path of unresolved) out.push({ file: null, path });
		return out;
	}

	// app.json userIgnoreFilters: a path prefix, or a /regex/.
	isUserIgnored(path: string) {
		const filters = this.vault.getConfig("userIgnoreFilters");
		if (!Array.isArray(filters)) return false;
		return filters.some((f) => {
			if (typeof f !== "string" || !f) return false;
			if (f.length > 2 && f.startsWith("/") && f.endsWith("/")) {
				try {
					return new RegExp(f.slice(1, -1)).test(path);
				} catch {
					return false;
				}
			}
			return path.startsWith(f);
		});
	}

	onCleanCache(cb: () => void) {
		if (this.resolved) cb();
		else this.#onClean.push(cb);
	}
}
