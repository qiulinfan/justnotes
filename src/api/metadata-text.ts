import * as nodePath from "node:path";
import { groupEnd, texText } from "../latex/tex/texText";
import { type CachedMetadata, type HeadingCache, type Loc, type Reference, type ReferenceCache, splitWikilink, WIKILINK, wikiDisplay } from "./metadata";

// The metadata cache of the notes that are not Markdown (see note-files.ts).
// A TeX file's sectioning commands are its headings and its \input,
// \include, \subfile and \import its links; a text file has the wikilinks it
// holds. Neither has frontmatter, tags, sections or blocks.

function locator(text: string) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	return (offset: number): Loc => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return { line: lo, col: offset - starts[lo], offset };
	};
}

function wikilinks(text: string, at: (offset: number) => Loc, out: CachedMetadata) {
	for (const m of text.matchAll(WIKILINK)) {
		const { link, alias } = splitWikilink(m[2]);
		if (!link && !alias) continue;
		const start = m.index ?? 0;
		const ref: ReferenceCache = { link, original: m[0], displayText: alias ?? wikiDisplay(link), position: { start: at(start), end: at(start + m[0].length) } };
		if (m[1]) (out.embeds ??= []).push(ref);
		else (out.links ??= []).push(ref);
	}
}

export function parseTextMetadata(text: string): CachedMetadata {
	const out: CachedMetadata = {};
	wikilinks(text, locator(text), out);
	return out;
}

const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const HEADING = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\b\*?\s*(?:\[[^\]\n]*\]\s*)?(?=\{)/g;
const INPUT = /\\(input|include|subfile|subfileinclude)\s*\{([^{}\n]+)\}/g;
const IMPORT = /\\((?:sub)?(?:import|inputfrom|includefrom))\*?\s*\{([^{}\n]*)\}\s*\{([^{}\n]+)\}/g;
const VERBATIM = /\\begin\s*\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|filecontents\*?)\}[\s\S]*?\\end\s*\{\1\}/g;

// Comments, verbatim text and \iffalse blocks turn into spaces, so offsets stay.
function code(text: string) {
	const blank = (s: string) => s.replace(/[^\n]/g, " ");
	return text
		.replace(VERBATIM, blank)
		.replace(/^[ \t]*\\iffalse\b[\s\S]*?^[ \t]*\\fi\b/gm, blank)
		.replace(/(^|[^\\])(%.*)$/gm, (_m, before: string, comment: string) => before + blank(comment));
}

// A TeX path as a vault link: TeX reads a name without an extension as .tex.
function texLink(dir: string, name: string) {
	const file = name.trim().replace(/^"(.*)"$/, "$1");
	if (!file || /[\\#]/.test(file)) return null;
	const joined = dir ? `${dir.trim().replace(/\/+$/, "")}/${file}` : file;
	return /\.[A-Za-z0-9]+$/.test(file) ? joined : `${joined}.tex`;
}

export function parseTexMetadata(text: string): CachedMetadata {
	const out: CachedMetadata = {};
	const at = locator(text);
	const src = code(text);
	const headings: HeadingCache[] = [];
	for (const m of src.matchAll(HEADING)) {
		const start = m.index ?? 0;
		const open = start + m[0].length;
		const end = groupEnd(src, open);
		const title = texText(src.slice(open + 1, end - 1)).replace(/\s+/g, " ").trim();
		headings.push({ heading: title || "(Untitled)", level: LEVELS[m[1]], position: { start: at(start), end: at(end) } });
	}
	// Levels start at 1 with the file's outermost command: a chapter file's
	// \section lines are its top headings.
	const top = Math.min(...headings.map((h) => h.level));
	for (const h of headings) h.level = Math.min(6, h.level - top + 1);
	if (headings.length) out.headings = headings;
	const links: ReferenceCache[] = [];
	const add = (start: number, length: number, link: string | null) => {
		if (link) links.push({ link, original: text.slice(start, start + length), displayText: link, position: { start: at(start), end: at(start + length) } });
	};
	for (const m of src.matchAll(INPUT)) add(m.index ?? 0, m[0].length, texLink("", m[2]));
	for (const m of src.matchAll(IMPORT)) add(m.index ?? 0, m[0].length, texLink(m[2], m[3]));
	links.sort((a, b) => a.position.start.offset - b.position.start.offset);
	if (links.length) out.links = links;
	return out;
}

// The parser for a note's extension (Markdown's is parseMetadata).
export function textParserFor(extension: string): ((text: string) => CachedMetadata) | null {
	return extension === "tex" ? parseTexMetadata : extension === "txt" ? parseTextMetadata : null;
}

// A TeX \input, \include or \subfile whose target or source moved. Its
// path is relative to a folder: the source's own when it resolved from
// there (the source's new folder then), else (TeX reads from the root
// document's folder) the one where the old target's path ends with it. The new path is the new target's relative to
// that folder, without .tex when the old one had none. A link whose folder
// cannot be told (\import) is kept.
export function texRelink(ref: Reference, source: { from: string; to: string }, targetPath: string, was: string) {
	const m = /^(\\(?:input|include|subfile|subfileinclude)\s*\{)([^{}]*)(\})$/.exec(ref.original);
	if (!m) return ref.original;
	const quoted = /^\s*".*"\s*$/.test(m[2]);
	const old = m[2].trim().replace(/^"(.*)"$/, "$1");
	const withExt = /\.[A-Za-z0-9]+$/.test(old) ? old : `${old}.tex`;
	const dir = (path: string) => (nodePath.posix.dirname(path) === "." ? "" : nodePath.posix.dirname(path));
	const fromSource = nodePath.posix.normalize(nodePath.posix.join(dir(source.from), withExt));
	let base: string;
	if (fromSource.toLowerCase() === was.toLowerCase()) base = dir(source.to);
	else {
		const suffix = nodePath.posix.normalize(withExt);
		if (suffix.startsWith("..") || !`/${was}`.toLowerCase().endsWith(`/${suffix}`.toLowerCase())) return ref.original;
		base = was.slice(0, was.length - suffix.length).replace(/\/$/, "");
	}
	let rel = nodePath.posix.relative(`/${base}`, `/${targetPath}`);
	if (withExt !== old && rel.endsWith(".tex")) rel = rel.slice(0, -4);
	return `${m[1]}${quoted ? `"${rel}"` : rel}${m[3]}`;
}
