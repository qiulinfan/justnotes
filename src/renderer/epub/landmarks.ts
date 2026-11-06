// A book's landmarks: the places a reading system can go straight to (the
// cover, the start of the text, the contents...), kept in EPUB 3's
// landmarks nav and in the OPF's <guide> (EPUB 2, and EPUB 3 books that
// keep one for older readers). Each kind has its name in both.
const OPS = "http://www.idpf.org/2007/ops";
const OPF = "http://www.idpf.org/2007/opf";

export interface LandmarkKind {
	type: string;
	guide: string;
	label: string;
}

export const LANDMARKS: LandmarkKind[] = [
	{ type: "cover", guide: "cover", label: "Cover" },
	{ type: "titlepage", guide: "title-page", label: "Title page" },
	{ type: "toc", guide: "toc", label: "Contents" },
	{ type: "bodymatter", guide: "text", label: "Start of text" },
	{ type: "preface", guide: "preface", label: "Preface" },
	{ type: "foreword", guide: "foreword", label: "Foreword" },
	{ type: "acknowledgments", guide: "acknowledgements", label: "Acknowledgments" },
	{ type: "bibliography", guide: "bibliography", label: "Bibliography" },
	{ type: "glossary", guide: "glossary", label: "Glossary" },
	{ type: "index", guide: "index", label: "Index" },
	{ type: "colophon", guide: "colophon", label: "Colophon" },
];

export const kindOf = (type: string) => LANDMARKS.find((k) => k.type === type || k.guide === type);

const epubType = (el: Element) => (el.getAttributeNS(OPS, "type") ?? el.getAttribute("epub:type") ?? "").split(/\s+/).filter(Boolean);

// The landmarks nav, made (hidden, after the other navs) when `make` is set.
export function landmarksList(doc: Document, make: boolean) {
	const nav = Array.from(doc.getElementsByTagName("nav")).find((el) => epubType(el).includes("landmarks"));
	const list = nav ? Array.from(nav.children).find((c) => c.localName === "ol") : null;
	if (list || !make) return list ?? null;
	const ns = doc.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml";
	const body = doc.getElementsByTagName("body")[0];
	if (!body) return null;
	const el = nav ?? body.appendChild(doc.createElementNS(ns, "nav"));
	if (!nav) {
		el.setAttributeNS(OPS, "epub:type", "landmarks");
		el.setAttribute("hidden", "hidden");
		el.appendChild(doc.createElementNS(ns, "h2")).textContent = "Landmarks";
	}
	return el.appendChild(doc.createElementNS(ns, "ol"));
}

// The nav's entries: kind, href, label.
export function navLandmarks(doc: Document) {
	const list = landmarksList(doc, false);
	if (!list) return [];
	return Array.from(list.getElementsByTagName("a")).flatMap((a) => {
		const kind = epubType(a).map(kindOf).find(Boolean);
		const href = a.getAttribute("href");
		return kind && href ? [{ type: kind.type, href, label: (a.textContent ?? "").trim() || kind.label }] : [];
	});
}

// Sets (href) or removes (null) the nav's entry of a kind.
export function setNavLandmark(doc: Document, kind: LandmarkKind, href: string | null) {
	const list = landmarksList(doc, href !== null);
	if (!list) return false;
	for (const a of Array.from(list.getElementsByTagName("a"))) {
		if (epubType(a).some((t) => kindOf(t) === kind)) (a.closest("li") ?? a).remove();
	}
	if (href !== null) {
		const ns = doc.documentElement.namespaceURI ?? "http://www.w3.org/1999/xhtml";
		const li = list.appendChild(doc.createElementNS(ns, "li"));
		const a = li.appendChild(doc.createElementNS(ns, "a"));
		a.setAttributeNS(OPS, "epub:type", kind.type);
		a.setAttribute("href", href);
		a.textContent = kind.label;
	}
	return true;
}

export function guideLandmarks(opf: Document) {
	const guide = opf.getElementsByTagNameNS(OPF, "guide")[0] ?? opf.getElementsByTagName("guide")[0];
	if (!guide) return [];
	return Array.from(guide.getElementsByTagName("*"))
		.filter((el) => el.localName === "reference")
		.flatMap((ref) => {
			const kind = kindOf(ref.getAttribute("type") ?? "");
			const href = ref.getAttribute("href");
			return kind && href ? [{ type: kind.type, href, label: ref.getAttribute("title") || kind.label }] : [];
		});
}

// Sets or removes the guide's reference of a kind; the guide is made (after
// the spine) only when `make` is set.
export function setGuideLandmark(opf: Document, kind: LandmarkKind, href: string | null, make: boolean) {
	let guide = opf.getElementsByTagNameNS(OPF, "guide")[0] ?? opf.getElementsByTagName("guide")[0];
	if (!guide) {
		if (!make || href === null) return false;
		const pkg = opf.documentElement;
		guide = opf.createElementNS(OPF, "guide");
		const spine = Array.from(pkg.children).find((c) => c.localName === "spine");
		pkg.insertBefore(guide, spine?.nextSibling ?? null);
	}
	for (const ref of Array.from(guide.getElementsByTagName("*"))) {
		if (ref.localName === "reference" && kindOf(ref.getAttribute("type") ?? "") === kind) ref.remove();
	}
	if (href !== null) {
		const ref = guide.appendChild(opf.createElementNS(OPF, "reference"));
		ref.setAttribute("type", kind.guide);
		ref.setAttribute("title", kind.label);
		ref.setAttribute("href", href);
	}
	return true;
}
