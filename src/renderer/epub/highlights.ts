// A book's highlights, kept in a Markdown note beside it ("Book.highlights.md"
// next to "Book.epub"), never in the book. Each highlight is a callout whose
// type is its colour and whose title links back to the place in the book;
// the quote is the callout's body, and what follows it, up to the next
// highlight, is the reader's own note:
//
//   > [!yellow|underline] [[Book.epub#text/ch1.xhtml:1234|Chapter One]]
//   > The words highlighted.
//
//   A note, in any Markdown.
//
// The link's subpath is the chapter and where the quote starts in the
// chapter's text (text-index.ts); the quote itself finds the place again
// when the book's text has moved. Text that is no highlight (before the
// first, or the reader's own headings) stays where it is.
import { occurrences, type TextIndex } from "./text-index";

export const COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export const STYLES = ["highlight", "underline", "wavy"] as const;
export type Color = (typeof COLORS)[number];
export type Style = (typeof STYLES)[number];

export interface Highlight {
	// The chapter's zip path and the quote's start in its text.
	path: string;
	offset: number;
	quote: string;
	color: Color;
	style: Style;
	// The chapter's name, as the link shows it.
	label: string;
	note: string;
}

export interface Highlights {
	// What comes before the first highlight.
	preamble: string;
	entries: Highlight[];
}

// The note's file beside the book: "a/Book.epub" → "a/Book.highlights.md".
export function highlightsPath(bookPath: string) {
	return bookPath.replace(/\.epub$/i, "") + ".highlights.md";
}

const HEADER = new RegExp(`^> ?\\[!(${COLORS.join("|")})(?:\\|(${STYLES.join("|")}))?\\][-+]? *\\[\\[[^\\]#|]*#([^\\]|]+):(\\d+)(?:\\|([^\\]]*))?\\]\\] *$`);

export function parseHighlights(markdown: string): Highlights {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const entries: Highlight[] = [];
	const preamble: string[] = [];
	let current: Highlight | null = null;
	let note: string[] = [];
	const finish = () => {
		if (current) current.note = trimLines(note);
		note = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const m = HEADER.exec(lines[i]);
		if (!m) {
			(current ? note : preamble).push(lines[i]);
			continue;
		}
		finish();
		const quote: string[] = [];
		while (i + 1 < lines.length && /^>/.test(lines[i + 1])) quote.push(lines[++i].replace(/^> ?/, ""));
		current = {
			color: m[1] as Color,
			style: (m[2] as Style) ?? "highlight",
			path: m[3],
			offset: Number(m[4]),
			label: (m[5] ?? "").trim(),
			quote: unescapeMarkdown(quote.join(" ")).replace(/\s+/g, " ").trim(),
			note: "",
		};
		entries.push(current);
	}
	finish();
	return { preamble: trimLines(preamble), entries };
}

// The note's text, highlights in the order `rank` gives (the book's).
// `link` is how the note links to the book from where it is ("Book.epub").
export function writeHighlights(doc: Highlights, link: string, rank: (h: Highlight) => number) {
	const sorted = [...doc.entries].sort((a, b) => rank(a) - rank(b) || a.offset - b.offset);
	const parts = doc.preamble ? [doc.preamble] : [];
	for (const h of sorted) {
		const kind = h.style === "highlight" ? h.color : `${h.color}|${h.style}`;
		const label = h.label ? `|${escapeLabel(h.label)}` : "";
		let block = `> [!${kind}] [[${link}#${h.path}:${h.offset}${label}]]\n> ${escapeMarkdown(h.quote)}`;
		if (h.note.trim()) block += `\n\n${h.note.trim()}`;
		parts.push(block);
	}
	return parts.length ? `${parts.join("\n\n")}\n` : "";
}

export const sameHighlight = (a: Highlight, b: Pick<Highlight, "path" | "offset">) => a.path === b.path && a.offset === b.offset;

// Where `h` starts in a chapter's text now: the occurrence of its quote
// nearest the offset it was made at; null when the quote is gone.
export function locate(index: TextIndex, h: Highlight) {
	const found = occurrences(index.text, h.quote, true);
	if (!found.length) return null;
	return found.reduce((best, at) => (Math.abs(at - h.offset) < Math.abs(best - h.offset) ? at : best));
}

// Inside a callout a quote is Markdown: what would format it is escaped.
function escapeMarkdown(text: string) {
	return text.replace(/[\\`*_[\]<>|~=$#^]/g, "\\$&");
}

function unescapeMarkdown(text: string) {
	return text.replace(/\\([\\`*_[\]<>|~=$#^])/g, "$1");
}

// A link's alias ends at "]]" and cannot hold "|".
function escapeLabel(text: string) {
	return text.replace(/[|\]\[#^]/g, " ").replace(/\s+/g, " ").trim();
}

function trimLines(lines: string[]) {
	return lines.join("\n").replace(/^\s*\n/, "").trimEnd();
}
