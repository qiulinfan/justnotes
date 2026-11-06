// A chapter between the book and the reader's frame. The model is the
// chapter's own parsed document, never shown; the display copy has its
// resource references (images, stylesheets, SVG images, media) pointed at
// URLs the view serves from the zip. Edits come back as the frame's <body>,
// which replaces the model's with the original references restored, so a
// saved chapter differs from the file only where the reader changed it.
import { type EpubBook, dirname, isExternalHref, parseMarkup, parseXml, resolvePath, serializeXml } from "./book";

const XLINK = "http://www.w3.org/1999/xlink";
const XMLNS = "http://www.w3.org/2000/xmlns/";

// The attributes that load a resource, by element (local names).
const RESOURCE_ATTRS: Record<string, string[]> = {
	img: ["src"],
	image: ["href", "xlink:href"],
	link: ["href"],
	script: ["src"],
	audio: ["src"],
	video: ["src", "poster"],
	source: ["src"],
	track: ["src"],
	object: ["data"],
	embed: ["src"],
	input: ["src"],
	use: ["href", "xlink:href"],
};

export interface Chapter {
	path: string;
	// The chapter's file text as loaded: its XML declaration and bytes outside
	// <body> stay as they were. Commits update it.
	text: string;
	// The text the display copy was made from.
	shown: string;
	model: Document & { lenient?: boolean };
	display: Document;
	// A display URL → the reference it replaced.
	urls: Map<string, string>;
}

export function loadChapter(book: EpubBook, path: string, urlFor: (path: string) => string | null): Chapter {
	const text = book.text(path);
	const model = parseMarkup(text, path);
	const display = model.cloneNode(true) as Document;
	const urls = new Map<string, string>();
	const dir = dirname(path);
	for (const el of Array.from(display.getElementsByTagName("*"))) {
		for (const attr of RESOURCE_ATTRS[el.localName] ?? []) {
			const value = attr === "xlink:href" ? el.getAttributeNS(XLINK, "href") : el.getAttribute(attr);
			if (!value || isExternalHref(value) || value.startsWith("#")) continue;
			const hash = value.indexOf("#");
			const url = urlFor(resolvePath(dir, value));
			if (!url) continue;
			const shown = hash < 0 ? url : url + value.slice(hash);
			urls.set(shown, value);
			if (attr === "xlink:href") el.setAttributeNS(XLINK, "xlink:href", shown);
			else el.setAttribute(attr, shown);
		}
		if (el.hasAttribute("style")) el.setAttribute("style", rewriteCss(el.getAttribute("style") ?? "", dir, urlFor, urls));
		if (el.localName === "style") el.textContent = rewriteCss(el.textContent ?? "", dir, urlFor, urls);
	}
	return { path, text, shown: text, model, display, urls };
}

// `url(...)` and `@import "..."` in a stylesheet (or a style attribute) at
// `dir`, pointed at their served URLs. `urls`, when given, learns each
// replacement so it can be undone.
export function rewriteCss(css: string, dir: string, urlFor: (path: string) => string | null, urls?: Map<string, string>) {
	const swap = (ref: string) => {
		if (!ref || isExternalHref(ref) || ref.startsWith("#")) return null;
		const url = urlFor(resolvePath(dir, ref));
		if (url) urls?.set(url, ref);
		return url;
	};
	return css
		.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/g, (whole, quote, ref) => {
			const url = swap(ref.trim());
			return url ? `url(${quote}${url}${quote})` : whole;
		})
		.replace(/@import\s+(['"])([^'"]+)\1/g, (whole, quote, ref) => {
			const url = swap(ref.trim());
			return url ? `@import ${quote}${url}${quote}` : whole;
		});
}

// The chapter's text with `body` (the frame's, edited) in place of its
// <body>. Display URLs go back to the references they replaced; the frame's
// own marks (designMode leaves none, but a spellchecker or the browser may
// add attributes) are left out by serializing only what the model allows.
export function commitBody(chapter: Chapter, body: HTMLElement) {
	const copy = body.cloneNode(true) as HTMLElement;
	for (const el of [copy, ...Array.from(copy.getElementsByTagName("*"))]) {
		for (const attr of Array.from(el.attributes)) {
			if (attr.name === "contenteditable" || attr.name === "spellcheck") {
				el.removeAttributeNode(attr);
				continue;
			}
			let value = attr.value;
			for (const [shown, original] of chapter.urls) if (value.includes(shown)) value = value.split(shown).join(original);
			if (value !== attr.value) attr.value = value;
		}
		if (el.localName === "style" && el.textContent) {
			let css = el.textContent;
			for (const [shown, original] of chapter.urls) css = css.split(shown).join(original);
			el.textContent = css;
		}
	}
	// XMLSerializer writes an HTML element as XHTML (namespace, closed empty
	// elements, escaped text), which parses back as XML. Serialized alone, the
	// body knows no prefix its ancestors declared (epub:type would become
	// ns1:type), so it carries their declarations while it is, and drops
	// them once it is back under them.
	const model = chapter.model;
	const old = model.getElementsByTagName("body")[0];
	const declared = old ? inheritedDeclarations(old) : [];
	for (const attr of declared) if (!copy.hasAttribute(attr.name)) copy.setAttributeNS(XMLNS, attr.name, attr.value);
	const xml = new XMLSerializer().serializeToString(copy);
	const parsed = parseXml(xml, chapter.path).documentElement;
	for (const attr of declared) if (!old?.hasAttribute(attr.name) && parsed.getAttribute(attr.name) === attr.value) parsed.removeAttribute(attr.name);
	const next = model.importNode(parsed, true) as Element;
	if (old) old.replaceWith(next);
	else model.documentElement.appendChild(next);
	if (model.lenient) return serializeLenient(model);
	const whole = serializeXml(model, chapter.text);
	// Only the body changed: it goes into the file's own text, so the rest
	// (the head, the doctype, how they were written) keeps its bytes.
	const edited = whole.match(BODY)?.[0];
	return edited && BODY.test(chapter.text) ? chapter.text.replace(BODY, () => edited) : whole;
}

const BODY = /<body[\s>/][\s\S]*<\/body\s*>|<body[^>]*\/>/;

// The namespace declarations (xmlns and xmlns:prefix) on the ancestors of
// `el`, nearest first.
function inheritedDeclarations(el: Element) {
	const seen = new Map<string, string>();
	for (let node = el.parentElement; node; node = node.parentElement) {
		for (const attr of Array.from(node.attributes)) {
			if (attr.namespaceURI === XMLNS && !seen.has(attr.name)) seen.set(attr.name, attr.value);
		}
	}
	return [...seen].map(([name, value]) => ({ name, value }));
}

// A chapter that was HTML rather than XHTML is written back as XHTML: the
// edit is the moment it can be made well-formed.
function serializeLenient(doc: Document) {
	const html = new XMLSerializer().serializeToString(doc.documentElement);
	return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n${html}`;
}
