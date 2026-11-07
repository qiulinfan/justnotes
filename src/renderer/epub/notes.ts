// Footnotes and endnotes, found from the link that points at them, so the
// reader can show a note where its mark is instead of jumping to it. Books
// mark notes in many ways: EPUB 3's epub:type (noteref, footnote, endnote),
// ARIA roles, a link back from the note to its mark (what converters and
// InDesign write), note classes, or only a short mark such as "1", "[2]",
// "a" or "*". The note's text is the element holding it, cleaned of its link
// back and of ids (it is shown in the page beside the original).
import { dirname, resolvePath } from "./book";

const OPS = "http://www.idpf.org/2007/ops";
const BLOCKS = new Set(["p", "div", "li", "dd", "dt", "dl", "aside", "section", "blockquote", "td", "th", "tr", "table", "ol", "ul", "figure", "body"]);
const HEADINGS = "h1, h2, h3, h4, h5, h6";
const NOTE_TYPES = ["footnote", "endnote", "rearnote", "note"];
const NOTE_ROLES = ["doc-footnote", "doc-endnote"];
// A class naming one note (not a list of them): footnote, note, endnote,
// fn, and converters' compounds such as "_idfootnote" or "footnote-text".
const NOTE_CLASS = /(^|[\s_-])(foot|end|rear)?note($|[\s_-])|(^|[\s_-])fn($|[\s_-])/i;
const REF_CLASS = /noteref|footnote|endnote|(^|[\s_-])fn/i;
// A note's mark: a number, a letter, a symbol or a circled number, perhaps in brackets.
const MARK = /^[[(（【〔]?\s*(\d{1,4}|[a-zA-Z]|[*†‡§¶#]{1,3}|[①-⓿❶-➓㉑-㉟㊱-㊿]|注\s*\d{0,4})\s*[\])）】〕]?$/;
// What a link back to the mark says when it says nothing else.
const BACK_TEXT = /^[\s[\]()（）【】]*(↩︎?|↩|↑|⤴|←\s*\d*|\^|back|返回|回到正文)?[\s[\]()（）【】]*$/i;
// Longer than this is a passage, not a note.
const MAX_TEXT = 6000;

const types = (el: Element) => (el.getAttributeNS(OPS, "type") || el.getAttribute("epub:type") || "").split(/\s+/).filter(Boolean);
const role = (el: Element) => el.getAttribute("role") ?? "";
const classes = (el: Element) => el.getAttribute("class") ?? "";
const isBlock = (el: Element) => BLOCKS.has(el.localName);

// The fragment and zip path `href` names from a file at `from`.
function target(href: string, from: string) {
	const hash = href.indexOf("#");
	if (hash < 0) return null;
	let fragment = href.slice(hash + 1);
	try {
		fragment = decodeURIComponent(fragment);
	} catch {}
	return { path: hash === 0 ? from : resolvePath(dirname(from), href), fragment };
}

function ancestors(el: Element) {
	const out: Element[] = [];
	for (let at: Element | null = el; at; at = at.parentElement) out.push(at);
	return out;
}

// The block the link's mark sits in, up to the body.
function blockOf(el: Element) {
	for (let at: Element | null = el; at; at = at.parentElement) if (isBlock(at)) return at;
	return el;
}

function markedAsNoteRef(link: Element) {
	const around = [...ancestors(link).slice(0, 4), ...Array.from(link.querySelectorAll("*"))];
	return around.some((el) => types(el).includes("noteref") || role(el) === "doc-noteref");
}

function markedAsNote(el: Element) {
	return types(el).some((t) => NOTE_TYPES.includes(t)) || NOTE_ROLES.includes(role(el)) || el.localName === "aside";
}

// The element holding the note `target` is in: the nearest one marked as a
// note, a list item, a definition (a dt's dd), else its block, widened to
// a parent that holds nothing but this note (several paragraphs of one).
export function noteRoot(target: Element): Element[] {
	const marked = ancestors(target).find((el) => el.localName !== "body" && (markedAsNote(el) || (isBlock(el) && NOTE_CLASS.test(classes(el)))));
	if (marked?.localName === "dt") return definitions(marked);
	if (marked) return [marked];
	const item = ancestors(target).find((el) => el.localName === "li" || el.localName === "dt" || el.localName === "dd");
	if (item?.localName === "dt") return definitions(item);
	if (item) return [item];
	let root = blockOf(target);
	while (root.parentElement && root.parentElement.localName !== "body" && ["div", "section", "aside", "blockquote"].includes(root.parentElement.localName)) {
		const parent = root.parentElement;
		const others = Array.from(parent.querySelectorAll("a[href*='#']")).some((a) => !root.contains(a));
		if (others || (parent.textContent?.length ?? 0) > MAX_TEXT) break;
		root = parent;
	}
	return [root];
}

// A term's definitions: the dd elements after it, up to the next term.
function definitions(dt: Element) {
	const out: Element[] = [];
	for (let at = dt.nextElementSibling; at && at.localName === "dd"; at = at.nextElementSibling) out.push(at);
	return out.length ? out : [dt];
}

// The ids that name where the link's mark is: the link's own, those around
// it, and any in its block (an empty anchor beside the link, often).
function markIds(link: Element) {
	const ids = new Set<string>();
	const add = (el: Element) => el.id && ids.add(el.id);
	for (const el of ancestors(link).slice(0, 4)) add(el);
	for (const el of Array.from(blockOf(link).querySelectorAll("[id]"))) add(el);
	for (const el of Array.from(link.querySelectorAll("[id]"))) add(el);
	return ids;
}

// The links in `nodes` (at `at`) that lead back to the mark.
function backLinks(nodes: Element[], at: string, from: string, ids: Set<string>) {
	const out: Element[] = [];
	for (const node of nodes) {
		const links = node.matches("a[href]") ? [node] : Array.from(node.querySelectorAll("a[href]"));
		for (const a of links) {
			const to = target(a.getAttribute("href") ?? "", at);
			if (to && to.path === from && ids.has(to.fragment)) out.push(a);
		}
	}
	return out;
}

export interface Note {
	// A clean copy of the note, in the target's document.
	content: Element;
	// The element the link points at (where "Go to note" goes).
	target: Element;
}

// The note `link` (in the chapter at `from`) points at, given the element
// its fragment names (`target`, in the chapter at `at`); null when the link
// is not a note's mark.
export function noteFor(link: Element, from: string, target: Element, at: string): Note | null {
	const explicit = markedAsNoteRef(link);
	// A heading's link, or one in a nav, goes to a place, not a note.
	if (!explicit && (link.closest(HEADINGS) || link.closest("nav"))) return null;
	const roots = noteRoot(target);
	const text = roots.map((el) => el.textContent ?? "").join("");
	if (!text.trim() && !roots.some((el) => el.querySelector("img, svg, image"))) return null;
	if (!explicit && (text.length > MAX_TEXT || roots.some((el) => el.matches(HEADINGS) || el.querySelector(HEADINGS)))) return null;
	const ids = markIds(link);
	const back = backLinks(roots, at, from, ids);
	const label = (link.textContent ?? "").trim();
	const hinted = ancestors(link).slice(0, 3).some((el) => REF_CLASS.test(classes(el))) || roots.some((el) => markedAsNote(el) || NOTE_CLASS.test(classes(el)));
	const note = explicit || back.length > 0 || roots.some(markedAsNote) || (hinted && label.length <= 8) || MARK.test(label);
	if (!note) return null;
	return { content: cleaned(roots, back), target };
}

// One element holding copies of `roots`, without the links back, the
// brackets they leave ("[ ]", "（）") or that lead the note empty, ids, or
// scripts.
function cleaned(roots: Element[], back: Element[]) {
	const doc = roots[0].ownerDocument;
	const marks = new Set(back);
	const wrap = doc.createElementNS(roots[0].namespaceURI, "div");
	for (const root of roots) {
		const copy = root.cloneNode(true) as Element;
		// The same walk in the original and the copy pairs the elements up.
		const originals = [root, ...Array.from(root.querySelectorAll("*"))];
		const copies = [copy, ...Array.from(copy.querySelectorAll("*"))];
		originals.forEach((el, i) => {
			if (el === root) return;
			const bare = el.localName === "a" && /#/.test(el.getAttribute("href") ?? "") && !el.querySelector("img, svg, image") && BACK_TEXT.test(el.textContent ?? "");
			// A mark (U+0000) where the link was, for the brackets around it.
			if (marks.has(el) || bare) copies[i].replaceWith(doc.createTextNode("\u0000"));
		});
		deleteText(copy, /[[(（【〔]?\s*\u0000\s*[\])）】〕]?/g);
		deleteText(copy, /^\s*[[(（【〔]\s*[\])）】〕]/g);
		for (const el of Array.from(copy.querySelectorAll("*")).reverse()) {
			if (!el.textContent?.trim() && !el.matches("img, svg, image, br, hr, video, audio") && !el.querySelector("img, svg, image, video, audio")) el.remove();
		}
		for (const el of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
			el.removeAttribute("id");
			el.removeAttribute("name");
		}
		for (const el of Array.from(copy.querySelectorAll("script"))) el.remove();
		wrap.append(copy);
	}
	return wrap;
}

// Deletes what `pattern` matches in `root`'s text, across the text nodes it
// is split into.
function deleteText(root: Element, pattern: RegExp) {
	const walker = root.ownerDocument.createTreeWalker(root, 4);
	const nodes: Text[] = [];
	for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
	const text = nodes.map((n) => n.data).join("");
	const cuts = Array.from(text.matchAll(pattern), (m) => [m.index, m.index + m[0].length]).filter(([a, b]) => b > a);
	let offset = 0;
	for (const node of nodes) {
		const start = offset;
		const end = offset + node.data.length;
		offset = end;
		let data = node.data;
		for (const [a, b] of [...cuts].reverse()) {
			const from = Math.max(a, start);
			const to = Math.min(b, end);
			if (to > from) data = data.slice(0, from - start) + data.slice(to - start);
		}
		node.data = data;
	}
}
