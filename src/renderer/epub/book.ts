// An EPUB as justnotes reads and edits it: the zip's entries in their order,
// the package document (OPF) with its manifest, spine and metadata, and the
// table of contents (EPUB 3's nav document, else EPUB 2's NCX). No UI here;
// the view (epub-view.ts) renders and edits chapters through it. Entries no
// edit touched keep their bytes; writing rezips everything with `mimetype`
// first and stored, as the format requires.
import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from "fflate";
import { guideLandmarks, kindOf, navLandmarks, setGuideLandmark, setNavLandmark } from "./landmarks";
import { occurrences, textIndex } from "./text-index";
import { indentEntry, insertEntry, navAdapter, ncxAdapter, outdentEntry, removeEntries, renameEntry, renumberPlayOrder, resortEntries, type TocAdapter } from "./toc-edit";

const DC = "http://purl.org/dc/elements/1.1/";
const OPF = "http://www.idpf.org/2007/opf";
const OPS = "http://www.idpf.org/2007/ops";

export interface ManifestItem {
	id: string;
	path: string;
	mediaType: string;
	properties: string[];
}

export interface SpineItem {
	id: string;
	path: string;
	linear: boolean;
}

// `path` is the zip path of the target, `fragment` the id inside it ("" for none).
export interface TocEntry {
	label: string;
	path: string;
	fragment: string;
	children: TocEntry[];
}

export interface BookMetadata {
	title: string;
	creator: string;
	language: string;
	publisher: string;
	description: string;
}

export interface SearchHit {
	index: number;
	path: string;
	occurrence: number;
	before: string;
	match: string;
	after: string;
}

export interface Landmark {
	type: string;
	label: string;
	path: string;
	fragment: string;
}

export const METADATA_FIELDS: (keyof BookMetadata)[] = ["title", "creator", "language", "publisher", "description"];

export class EpubBook {
	#entries: Map<string, Uint8Array>;
	readonly opfPath: string;
	#opf: XMLDocument;
	#opfText: string;
	readonly manifest = new Map<string, ManifestItem>();
	readonly spine: SpineItem[] = [];
	toc: TocEntry[] = [];

	private constructor(entries: Map<string, Uint8Array>) {
		this.#entries = entries;
		const container = this.#xml("META-INF/container.xml");
		const rootfile = container.getElementsByTagName("rootfile")[0]?.getAttribute("full-path");
		if (!rootfile) throw new Error("Not an EPUB: META-INF/container.xml names no package document");
		this.opfPath = decodePath(rootfile);
		this.#opfText = this.text(this.opfPath);
		this.#opf = parseXml(this.#opfText, this.opfPath);
		this.#readPackage();
	}

	static read(data: ArrayBuffer | Uint8Array) {
		const files = unzipSync(data instanceof Uint8Array ? data : new Uint8Array(data));
		return new EpubBook(new Map(Object.entries(files)));
	}

	has(path: string) {
		return this.#entries.has(path);
	}

	bytes(path: string) {
		const data = this.#entries.get(path);
		if (!data) throw new Error(`${path} is not in the book`);
		return data;
	}

	text(path: string) {
		return strFromU8(this.bytes(path)).replace(/^﻿/, "");
	}

	setText(path: string, text: string) {
		if (!this.#entries.has(path)) throw new Error(`${path} is not in the book`);
		this.#entries.set(path, strToU8(text));
		if (path === this.opfPath) {
			this.#opfText = text;
			this.#opf = parseXml(text, path);
			this.#readPackage();
		} else if (this.#tocSource() === path) this.toc = this.#readToc();
	}

	// The media type the manifest gives a path, else one guessed from its name.
	mediaType(path: string) {
		for (const item of this.manifest.values()) if (item.path === path) return item.mediaType;
		return guessMediaType(path);
	}

	metadata(): BookMetadata {
		const value = (name: string) => this.#opf.getElementsByTagNameNS(DC, name)[0]?.textContent?.trim() ?? "";
		return { title: value("title"), creator: value("creator"), language: value("language"), publisher: value("publisher"), description: value("description") };
	}

	// Writes the changed fields into the OPF, leaving every other element as
	// it is: an emptied field's element goes (except the title, which EPUB
	// requires), a new one is added at the end of <metadata>. dcterms:modified,
	// when the book has it, becomes now.
	setMetadata(changes: Partial<BookMetadata>, now = new Date()) {
		const meta = this.#opf.getElementsByTagNameNS(OPF, "metadata")[0] ?? this.#opf.getElementsByTagName("metadata")[0];
		if (!meta) throw new Error("The package document has no <metadata>");
		let changed = false;
		for (const field of METADATA_FIELDS) {
			const next = changes[field];
			if (next === undefined) continue;
			const value = next.trim();
			const el = this.#opf.getElementsByTagNameNS(DC, field)[0];
			if ((el?.textContent?.trim() ?? "") === value) continue;
			changed = true;
			if (el && !value && field !== "title") el.remove();
			else if (el) el.textContent = value;
			else if (value) {
				const prefix = meta.lookupPrefix(DC) ?? "dc";
				const created = this.#opf.createElementNS(DC, `${prefix}:${field}`);
				created.textContent = value;
				meta.appendChild(created);
			}
		}
		if (!changed) return false;
		for (const el of Array.from(meta.getElementsByTagName("meta"))) {
			if (el.getAttribute("property") === "dcterms:modified") el.textContent = now.toISOString().replace(/\.\d+Z$/, "Z");
		}
		this.setText(this.opfPath, serializeXml(this.#opf, this.#opfText));
		return true;
	}

	// The zip: `mimetype` first and stored, already compressed media stored,
	// the rest deflated, in the book's own order.
	toBytes() {
		const files: Zippable = {};
		const mimetype = this.#entries.get("mimetype") ?? strToU8("application/epub+zip");
		files.mimetype = [mimetype, { level: 0 }];
		for (const [path, data] of this.#entries) {
			if (path === "mimetype" || path.endsWith("/")) continue;
			files[path] = [data, { level: STORED.test(path) ? 0 : 6 }];
		}
		return zipSync(files);
	}

	// The spine item that holds a path, or -1.
	spineIndexOf(path: string) {
		return this.spine.findIndex((item) => item.path === path);
	}

	// --- Snapshots (undo of structure changes) ----------------------------

	// The entries are never changed in place (setText replaces them), so a
	// copy of the map is the whole book.
	snapshot(): Map<string, Uint8Array> {
		return new Map(this.#entries);
	}

	restore(snapshot: Map<string, Uint8Array>) {
		this.#entries = new Map(snapshot);
		this.#opfText = this.text(this.opfPath);
		this.#opf = parseXml(this.#opfText, this.opfPath);
		this.#obfuscated = null;
		this.#readPackage();
	}

	// --- Resources --------------------------------------------------------

	// An entry as a reader needs it: fonts obfuscated by the IDPF or Adobe
	// algorithm (META-INF/encryption.xml) come back usable. The zip keeps
	// the obfuscated bytes.
	resource(path: string) {
		const data = this.bytes(path);
		const algorithm = this.#obfuscation().get(path);
		if (!algorithm) return data;
		const key = algorithm === "idpf" ? this.#idpfKey() : this.#adobeKey();
		if (!key) return data;
		return deobfuscate(data, key, algorithm === "idpf" ? 1040 : 1024);
	}

	#obfuscated: Map<string, "idpf" | "adobe"> | null = null;

	#obfuscation() {
		if (this.#obfuscated) return this.#obfuscated;
		const found = new Map<string, "idpf" | "adobe">();
		this.#obfuscated = found;
		if (!this.#entries.has("META-INF/encryption.xml")) return found;
		try {
			const doc = parseXml(this.text("META-INF/encryption.xml"), "META-INF/encryption.xml");
			for (const data of Array.from(doc.getElementsByTagName("*")).filter((el) => el.localName === "EncryptedData")) {
				const method = Array.from(data.getElementsByTagName("*")).find((el) => el.localName === "EncryptionMethod")?.getAttribute("Algorithm");
				const uri = Array.from(data.getElementsByTagName("*")).find((el) => el.localName === "CipherReference")?.getAttribute("URI");
				if (!uri) continue;
				const path = resolvePath("", uri);
				if (method === "http://www.idpf.org/2008/embedding") found.set(path, "idpf");
				else if (method === "http://ns.adobe.com/pdf/enc#RC") found.set(path, "adobe");
			}
		} catch (err) {
			console.error("Could not read META-INF/encryption.xml", err);
		}
		return found;
	}

	// The package's unique identifier: the dc:identifier the package names.
	#uniqueIdentifier() {
		const id = this.#opf.documentElement.getAttribute("unique-identifier");
		const ids = Array.from(this.#opf.getElementsByTagNameNS(DC, "identifier"));
		return ((id ? ids.find((el) => el.getAttribute("id") === id) : null) ?? ids[0])?.textContent ?? "";
	}

	#idpfKey() {
		const id = this.#uniqueIdentifier().replace(/[ \u0009\u000d\u000a]/g, "");
		return id ? new Uint8Array(createHash("sha1").update(id, "utf8").digest()) : null;
	}

	#adobeKey() {
		const hex = this.#uniqueIdentifier().replace(/^urn:uuid:/i, "").replace(/[^0-9a-f]/gi, "");
		if (hex.length !== 32) return null;
		return new Uint8Array(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)));
	}

	// --- Search -----------------------------------------------------------

	#plain = new Map<string, { data: Uint8Array; text: string }>();

	// A chapter's text as a reader sees it (its <body>, whitespace runs as
	// one space), cached until the chapter changes.
	plainText(path: string) {
		const data = this.bytes(path);
		const cached = this.#plain.get(path);
		if (cached?.data === data) return cached.text;
		let text = "";
		try {
			const body = parseMarkup(this.text(path), path).getElementsByTagName("body")[0];
			if (body) text = textIndex(body).text;
		} catch {}
		this.#plain.set(path, { data, text });
		return text;
	}

	// Every occurrence of `query` in the spine's chapters, in reading order:
	// the chapter, which occurrence in it, and the text around it.
	search(query: string, caseSensitive = false, limit = 500): SearchHit[] {
		const needle = query.replace(/\s+/g, " ");
		if (!needle.trim()) return [];
		const hits: SearchHit[] = [];
		for (const [index, item] of this.spine.entries()) {
			const text = this.plainText(item.path);
			for (const [occurrence, at] of occurrences(text, needle, caseSensitive).entries()) {
				hits.push({ index, path: item.path, occurrence, before: text.slice(Math.max(0, at - 40), at), match: text.slice(at, at + needle.length), after: text.slice(at + needle.length, at + needle.length + 60) });
				if (hits.length >= limit) return hits;
			}
		}
		return hits;
	}

	// --- Structure ----------------------------------------------------------

	get version() {
		return this.#opf.documentElement.getAttribute("version") ?? "3.0";
	}

	// A file added to the zip and the manifest, its name made unique in `dir`.
	addResource(dir: string, name: string, data: Uint8Array, mediaType = guessMediaType(name)) {
		const path = this.#uniquePath(dir, name);
		this.#entries.set(path, data);
		const item = this.#opf.createElementNS(OPF, "item");
		item.setAttribute("id", this.#uniqueId(name));
		item.setAttribute("href", relativeHref(dirname(this.opfPath), path));
		item.setAttribute("media-type", mediaType);
		this.#manifestEl().appendChild(item);
		this.#commitOpf();
		return path;
	}

	// Where the book keeps its images: the folder with the most, else an
	// Images folder beside the package document.
	imageDir() {
		const counts = new Map<string, number>();
		for (const item of this.manifest.values()) if (item.mediaType.startsWith("image/")) counts.set(dirname(item.path), (counts.get(dirname(item.path)) ?? 0) + 1);
		const best = [...counts].sort((a, b) => b[1] - a[1])[0];
		if (best) return best[0];
		const dir = dirname(this.opfPath);
		return dir ? `${dir}/Images` : "Images";
	}

	// A new chapter after spine item `after` (-1: first), in that chapter's
	// folder with its stylesheets, listed in the contents after its entry.
	// Returns the new chapter's spine index.
	addChapter(after: number, title: string) {
		const model = this.spine[Math.max(0, after)] ?? this.spine[0];
		const dir = model ? dirname(model.path) : dirname(this.opfPath);
		const links = model ? stylesheetHrefs(this.text(model.path), model.path) : [];
		const lang = this.metadata().language;
		const path = this.#uniquePath(dir, "chapter.xhtml");
		this.#entries.set(path, strToU8(chapterTemplate(title, links, lang, this.version.startsWith("2"))));
		const id = this.#uniqueId("chapter");
		const item = this.#opf.createElementNS(OPF, "item");
		item.setAttribute("id", id);
		item.setAttribute("href", relativeHref(dirname(this.opfPath), path));
		item.setAttribute("media-type", "application/xhtml+xml");
		this.#manifestEl().appendChild(item);
		const ref = this.#opf.createElementNS(OPF, "itemref");
		ref.setAttribute("idref", id);
		const refs = this.#itemrefs();
		const spineEl = this.#spineEl();
		spineEl.insertBefore(ref, after < 0 ? (refs[0] ?? null) : (refs[this.#refIndex(after)]?.nextSibling ?? null));
		this.#commitOpf();
		const index = this.spineIndexOf(path);
		this.#editTocs((adapter, doc, tocDir) => insertEntry(adapter, doc, tocDir, index, relativeHref(tocDir, path), title, (p) => this.spineIndexOf(p)));
		return index;
	}

	// Removes a chapter: its spine entry, manifest item, file and contents
	// entries (their sub-entries move up). The nav document and the last
	// chapter stay.
	deleteChapter(index: number) {
		const item = this.spine[index];
		if (!item) throw new Error("No such chapter");
		if (this.spine.length < 2) throw new Error("A book needs at least one chapter");
		if (this.manifest.get(item.id)?.properties.includes("nav")) throw new Error("The contents page cannot be deleted");
		this.#itemrefs()[this.#refIndex(index)]?.remove();
		const stillUsed = this.#itemrefs().some((ref) => ref.getAttribute("idref") === item.id);
		if (!stillUsed) {
			for (const el of Array.from(this.#opf.getElementsByTagName("item"))) if (el.getAttribute("id") === item.id) el.remove();
			this.#entries.delete(item.path);
		}
		this.#commitOpf();
		this.#editTocs((adapter, doc, tocDir) => removeEntries(adapter, doc, tocDir, item.path));
		// Landmarks that named the removed file go too.
		if (!stillUsed) for (const mark of this.landmarks()) if (mark.path === item.path) this.setLandmark(mark.type, null);
	}

	// Moves a chapter to spine index `to`; the contents lists holding it
	// follow the new order.
	moveChapter(index: number, to: number) {
		const item = this.spine[index];
		if (!item || to === index || to < 0 || to >= this.spine.length) return false;
		const refs = this.#itemrefs();
		const ref = refs[this.#refIndex(index)];
		const spineEl = this.#spineEl();
		ref.remove();
		const rest = this.#itemrefs();
		const anchorIndex = this.#refIndexIn(rest, to);
		spineEl.insertBefore(ref, anchorIndex < 0 ? null : rest[anchorIndex]);
		this.#commitOpf();
		this.#editTocs((adapter, doc, tocDir) => resortEntries(adapter, doc, tocDir, item.path, (p) => this.spineIndexOf(p)));
		return true;
	}

	// A contents entry stands for its spine item and those after it up to the
	// next entry's (a story split over several files is one section).
	sectionOf(index: number) {
		const starts = new Set<number>([0]);
		const walk = (entries: TocEntry[]) => {
			for (const e of entries) {
				const at = this.spineIndexOf(e.path);
				if (at >= 0) starts.add(at);
				walk(e.children);
			}
		};
		walk(this.toc);
		const sorted = [...starts].sort((a, b) => a - b);
		const start = sorted.filter((s) => s <= index).pop() ?? 0;
		const next = sorted.find((s) => s > index);
		return { start, end: (next ?? this.spine.length) - 1 };
	}

	// Moves the chapter of the section holding `index` past its neighbour
	// at its level of the contents (-1: the one before, 1: the one after):
	// each with its sub-entries' files, so the contents and the reading
	// order stay alike. Returns the moved chapter's new first index, or -1
	// when there is no neighbour (or the contents and the spine disagree
	// there). A book whose contents do not list it moves by sections.
	moveSection(index: number, direction: -1 | 1) {
		const start = this.sectionOf(index).start;
		const flat = flattenToc(this.toc).map((f) => ({ ...f, at: this.spineIndexOf(f.entry.path) }));
		const me = flat.find((f) => f.at === start);
		if (!me) return this.#moveBySections(start, direction);
		const siblings = (me.parent ? me.parent.children : this.toc).filter((e) => this.spineIndexOf(e.path) >= 0);
		const other = siblings[siblings.indexOf(me.entry) + direction];
		if (!other) return -1;
		const block = (entry: TocEntry) => {
			const i = flat.findIndex((f) => f.entry === entry);
			const s = flat[i].at;
			let j = i + 1;
			while (j < flat.length && flat[j].depth > flat[i].depth) j++;
			const next = flat.slice(j).find((f) => f.at > s);
			return { s, e: (next ? next.at : this.spine.length) - 1 };
		};
		const [first, second] = direction < 0 ? [block(other), block(me.entry)] : [block(me.entry), block(other)];
		if (first.e + 1 !== second.s) return -1;
		for (let k = 0; k <= second.e - second.s; k++) this.moveChapter(second.s + k, first.s + k);
		return direction < 0 ? first.s : first.s + (second.e - second.s + 1);
	}

	#moveBySections(start: number, direction: -1 | 1) {
		const cur = this.sectionOf(start);
		if (direction < 0) {
			if (cur.start === 0) return -1;
			const prev = this.sectionOf(cur.start - 1);
			for (let k = 0; k <= cur.end - cur.start; k++) this.moveChapter(cur.start + k, prev.start + k);
			return prev.start;
		}
		if (cur.end >= this.spine.length - 1) return -1;
		const next = this.sectionOf(cur.end + 1);
		for (let k = 0; k <= next.end - next.start; k++) this.moveChapter(next.start + k, cur.start + k);
		return cur.start + (next.end - next.start + 1);
	}

	// Deletes every chapter of the section holding `index`; returns where
	// the reader goes next.
	deleteSection(index: number) {
		const { start, end } = this.sectionOf(index);
		if (end - start + 1 >= this.spine.length) throw new Error("A book needs at least one chapter");
		for (let i = end; i >= start; i--) this.deleteChapter(i);
		return Math.max(0, Math.min(start, this.spine.length - 1));
	}

	// The book's landmarks, from the landmarks nav, then the guide's that the
	// nav lacks.
	landmarks(): Landmark[] {
		const out: Landmark[] = [];
		const nav = this.#navPath();
		if (nav) {
			try {
				const dir = dirname(nav);
				for (const l of navLandmarks(parseXml(this.text(nav), nav))) out.push({ type: l.type, label: l.label, ...target(dir, l.href) });
			} catch {}
		}
		const dir = dirname(this.opfPath);
		for (const l of guideLandmarks(this.#opf)) if (!out.some((o) => o.type === l.type)) out.push({ type: l.type, label: l.label, ...target(dir, l.href) });
		return out;
	}

	// Marks spine item `index` as the landmark of a kind (null: unmarks the
	// kind), in the landmarks nav (made when the book has a nav) and in the
	// guide (made in EPUB 2, kept up to date in EPUB 3 when there is one).
	setLandmark(type: string, index: number | null) {
		const kind = kindOf(type);
		if (!kind) throw new Error(`Unknown landmark ${type}`);
		const path = index === null ? null : this.spine[index]?.path;
		if (index !== null && !path) throw new Error("No such chapter");
		const nav = this.#navPath();
		if (nav) {
			const text = this.text(nav);
			const doc = parseXml(text, nav);
			if (setNavLandmark(doc, kind, path ? relativeHref(dirname(nav), path) : null)) this.setText(nav, serializeXml(doc, text));
		}
		if (setGuideLandmark(this.#opf, kind, path ? relativeHref(dirname(this.opfPath), path) : null, this.version.startsWith("2") || !nav)) this.#commitOpf();
	}

	#navPath() {
		const nav = [...this.manifest.values()].find((item) => item.properties.includes("nav"))?.path;
		return nav && this.#entries.has(nav) ? nav : null;
	}

	// Nests a chapter's contents entry under the one before it (1) or takes
	// it up a level (-1); false when it cannot go that way.
	nestChapter(index: number, direction: 1 | -1) {
		const item = this.spine[index];
		if (!item) return false;
		let changed = false;
		this.#editTocs((adapter, doc, tocDir) => {
			const done = direction > 0 ? indentEntry(adapter, doc, tocDir, item.path) : outdentEntry(adapter, doc, tocDir, item.path);
			changed ||= done;
			return done;
		});
		return changed;
	}

	// How deep a chapter's first contents entry is (0: the top list), or -1.
	tocDepth(path: string) {
		const find = (entries: TocEntry[], depth: number): number => {
			for (const e of entries) {
				if (e.path === path) return depth;
				const sub = find(e.children, depth + 1);
				if (sub >= 0) return sub;
			}
			return -1;
		};
		return find(this.toc, 0);
	}

	// Renames a chapter's contents entry, adding one when it has none.
	renameChapter(index: number, title: string) {
		const item = this.spine[index];
		if (!item) return;
		this.#editTocs((adapter, doc, tocDir) =>
			renameEntry(adapter, doc, tocDir, item.path, title) || insertEntry(adapter, doc, tocDir, index, relativeHref(tocDir, item.path), title, (p) => this.spineIndexOf(p)),
		);
	}

	// The label the contents give a chapter (its first entry), or "".
	// The labels from the contents' top down to the first entry for `path`
	// ("Book Two", "Chapter One"); empty when no entry names it.
	tocTrail(path: string): string[] {
		const find = (entries: TocEntry[], above: string[]): string[] => {
			for (const e of entries) {
				const here = [...above, e.label];
				if (e.path === path) return here;
				const sub = find(e.children, here);
				if (sub.length) return sub;
			}
			return [];
		};
		return find(this.toc, []);
	}

	tocLabel(path: string) {
		const find = (entries: TocEntry[]): string => {
			for (const e of entries) {
				if (e.path === path) return e.label;
				const sub = find(e.children);
				if (sub) return sub;
			}
			return "";
		};
		return find(this.toc);
	}

	#manifestEl() {
		const el = this.#opf.getElementsByTagNameNS(OPF, "manifest")[0] ?? this.#opf.getElementsByTagName("manifest")[0];
		if (!el) throw new Error("The package document has no <manifest>");
		return el;
	}

	#spineEl() {
		const el = this.#opf.getElementsByTagNameNS(OPF, "spine")[0] ?? this.#opf.getElementsByTagName("spine")[0];
		if (!el) throw new Error("The package document has no <spine>");
		return el;
	}

	// The <itemref>s that made spine entries (refs to missing files are skipped
	// in this.spine, so indices are mapped).
	#itemrefs() {
		return Array.from(this.#spineEl().getElementsByTagName("*")).filter((el) => el.localName === "itemref");
	}

	#refIndex(spineIndex: number) {
		return this.#refIndexIn(this.#itemrefs(), spineIndex);
	}

	#refIndexIn(refs: Element[], spineIndex: number) {
		let n = -1;
		for (const [i, ref] of refs.entries()) {
			const item = this.manifest.get(ref.getAttribute("idref") ?? "");
			if (item && this.#entries.has(item.path) && ++n === spineIndex) return i;
		}
		return -1;
	}

	#uniquePath(dir: string, name: string) {
		const dot = name.lastIndexOf(".");
		const stem = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		const join = (file: string) => (dir ? `${dir}/${file}` : file);
		let path = join(name);
		for (let n = 2; this.#entries.has(path); n++) path = join(`${stem}-${n}${ext}`);
		return path;
	}

	#uniqueId(base: string) {
		const ids = new Set(Array.from(this.#opf.getElementsByTagName("*")).map((el) => el.getAttribute("id")));
		const clean = base.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^([^A-Za-z_])/, "_$1") || "item";
		let id = clean;
		for (let n = 2; ids.has(id); n++) id = `${clean}-${n}`;
		return id;
	}

	#commitOpf() {
		this.setText(this.opfPath, serializeXml(this.#opf, this.#opfText));
	}

	// Applies an edit to each contents document the book has (nav, NCX).
	#editTocs(edit: (adapter: TocAdapter, doc: Document, dir: string) => boolean) {
		const nav = [...this.manifest.values()].find((item) => item.properties.includes("nav"))?.path;
		const spine = this.#spineEl();
		const ncx = (this.manifest.get(spine.getAttribute("toc") ?? "") ?? [...this.manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml"))?.path;
		for (const [path, adapter] of [
			[nav, navAdapter],
			[ncx, ncxAdapter],
		] as const) {
			if (!path || !this.#entries.has(path)) continue;
			const text = this.text(path);
			let doc: Document;
			try {
				doc = parseXml(text, path);
			} catch {
				continue;
			}
			if (!edit(adapter, doc, dirname(path))) continue;
			if (adapter === ncxAdapter) renumberPlayOrder(doc, dirname(path), (p) => this.spineIndexOf(p));
			this.setText(path, serializeXml(doc, text));
		}
	}

	#xml(path: string) {
		return parseXml(this.text(path), path);
	}

	#readPackage() {
		const dir = dirname(this.opfPath);
		this.manifest.clear();
		for (const el of Array.from(this.#opf.getElementsByTagName("item"))) {
			const id = el.getAttribute("id");
			const href = el.getAttribute("href");
			if (!id || !href) continue;
			const properties = (el.getAttribute("properties") ?? "").split(/\s+/).filter(Boolean);
			this.manifest.set(id, { id, path: resolvePath(dir, href), mediaType: el.getAttribute("media-type") ?? guessMediaType(href), properties });
		}
		this.spine.length = 0;
		for (const el of Array.from(this.#opf.getElementsByTagName("itemref"))) {
			const item = this.manifest.get(el.getAttribute("idref") ?? "");
			if (item && this.#entries.has(item.path)) this.spine.push({ id: item.id, path: item.path, linear: el.getAttribute("linear") !== "no" });
		}
		this.toc = this.#readToc();
	}

	#tocSource() {
		const nav = [...this.manifest.values()].find((item) => item.properties.includes("nav"));
		if (nav && this.#entries.has(nav.path)) return nav.path;
		const spine = this.#opf.getElementsByTagName("spine")[0];
		const ncx = this.manifest.get(spine?.getAttribute("toc") ?? "") ?? [...this.manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
		return ncx && this.#entries.has(ncx.path) ? ncx.path : null;
	}

	// A broken table of contents leaves the book readable through its spine.
	#readToc(): TocEntry[] {
		const source = this.#tocSource();
		if (!source) return [];
		try {
			const doc = parseMarkup(this.text(source), source);
			return source.endsWith(".ncx") || doc.documentElement.localName === "ncx" ? readNcx(doc, dirname(source)) : readNav(doc, dirname(source));
		} catch (err) {
			console.error(`Could not read the table of contents ${source}`, err);
			return [];
		}
	}
}

// The contents in reading order, each entry with its depth and parent.
function flattenToc(entries: TocEntry[], depth = 0, parent: TocEntry | null = null, out: { entry: TocEntry; depth: number; parent: TocEntry | null }[] = []) {
	for (const entry of entries) {
		out.push({ entry, depth, parent });
		flattenToc(entry.children, depth + 1, entry, out);
	}
	return out;
}

function readNav(doc: Document, dir: string): TocEntry[] {
	const navs = Array.from(doc.getElementsByTagName("nav"));
	const nav = navs.find((el) => (el.getAttributeNS(OPS, "type") ?? el.getAttribute("epub:type") ?? "").split(/\s+/).includes("toc")) ?? navs[0];
	const list = nav && Array.from(nav.children).find((el) => el.localName === "ol");
	return list ? navList(list, dir) : [];
}

function navList(list: Element, dir: string): TocEntry[] {
	const entries: TocEntry[] = [];
	for (const li of Array.from(list.children)) {
		if (li.localName !== "li") continue;
		const head = Array.from(li.children).find((el) => el.localName === "a" || el.localName === "span");
		const sub = Array.from(li.children).find((el) => el.localName === "ol");
		const href = head?.localName === "a" ? head.getAttribute("href") : null;
		entries.push({ label: collapse(head?.textContent ?? ""), ...target(dir, href), children: sub ? navList(sub, dir) : [] });
	}
	return entries;
}

function readNcx(doc: Document, dir: string): TocEntry[] {
	const map = doc.getElementsByTagName("navMap")[0];
	return map ? ncxPoints(map, dir) : [];
}

function ncxPoints(parent: Element, dir: string): TocEntry[] {
	return Array.from(parent.children)
		.filter((el) => el.localName === "navPoint")
		.map((point) => {
			const label = Array.from(point.children).find((el) => el.localName === "navLabel");
			const content = Array.from(point.children).find((el) => el.localName === "content");
			return { label: collapse(label?.textContent ?? ""), ...target(dir, content?.getAttribute("src") ?? null), children: ncxPoints(point, dir) };
		});
}

function target(dir: string, href: string | null) {
	if (!href) return { path: "", fragment: "" };
	const hash = href.indexOf("#");
	const path = hash < 0 ? href : href.slice(0, hash);
	return { path: path ? resolvePath(dir, path) : "", fragment: hash < 0 ? "" : decodeFragment(href.slice(hash + 1)) };
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

const decodeFragment = (fragment: string) => {
	try {
		return decodeURIComponent(fragment);
	} catch {
		return fragment;
	}
};

// Zip paths are plain; hrefs are URLs relative to the file that holds them.
export function decodePath(href: string) {
	try {
		return decodeURI(href);
	} catch {
		return href;
	}
}

export function dirname(path: string) {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

// The zip path `href` names from a file in `dir`: query and fragment dropped,
// `.` and `..` folded, never above the root.
export function resolvePath(dir: string, href: string) {
	const clean = decodePath(href.replace(/[?#].*$/, ""));
	const parts = clean.startsWith("/") ? [] : dir.split("/").filter(Boolean);
	for (const part of clean.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") parts.pop();
		else parts.push(part);
	}
	return parts.join("/");
}

// The href from a file in `dir` to the zip path `to`, with the characters
// a URL cannot hold escaped.
export function relativeHref(dir: string, to: string) {
	const from = dir.split("/").filter(Boolean);
	const parts = to.split("/");
	let common = 0;
	while (common < from.length && common < parts.length - 1 && from[common] === parts[common]) common++;
	const rel = [...from.slice(common).map(() => ".."), ...parts.slice(common)].join("/");
	return rel.replace(/%/g, "%25").replace(/ /g, "%20").replace(/#/g, "%23").replace(/\?/g, "%3F");
}

// XOR of the first `length` bytes with the key, as font obfuscation does.
export function deobfuscate(data: Uint8Array, key: Uint8Array, length: number) {
	const out = data.slice();
	for (let i = 0; i < Math.min(length, out.length); i++) out[i] ^= key[i % key.length];
	return out;
}

// The stylesheet hrefs a chapter links, as written.
function stylesheetHrefs(text: string, path: string) {
	try {
		const doc = parseMarkup(text, path);
		return Array.from(doc.getElementsByTagName("link"))
			.filter((l) => (l.getAttribute("rel") ?? "").split(/\s+/).includes("stylesheet"))
			.map((l) => l.getAttribute("href") ?? "")
			.filter(Boolean);
	} catch {
		return [];
	}
}

const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A new chapter's XHTML: the title as its heading, an empty paragraph.
function chapterTemplate(title: string, stylesheets: string[], lang: string, epub2: boolean) {
	const doctype = epub2 ? '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">' : "<!DOCTYPE html>";
	const langAttrs = lang ? ` xml:lang="${escapeXml(lang)}"${epub2 ? "" : ` lang="${escapeXml(lang)}"`}` : "";
	const ns = epub2 ? "" : ' xmlns:epub="http://www.idpf.org/2007/ops"';
	const links = stylesheets.map((href) => `\n<link rel="stylesheet" type="text/css" href="${escapeXml(href)}"/>`).join("");
	return `<?xml version="1.0" encoding="utf-8"?>
${doctype}
<html xmlns="http://www.w3.org/1999/xhtml"${ns}${langAttrs}>
<head>
<title>${escapeXml(title)}</title>${links}
</head>
<body>
<h1>${escapeXml(title)}</h1>
<p></p>
</body>
</html>
`;
}

// An href that leaves the book (a scheme such as https: or mailto:).
export function isExternalHref(href: string) {
	return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

export function parseXml(text: string, path: string): XMLDocument {
	const doc = new DOMParser().parseFromString(text, "application/xml");
	const error = doc.getElementsByTagName("parsererror")[0];
	if (error) throw new Error(`${path} is not well-formed XML: ${collapse(error.textContent ?? "")}`);
	return doc;
}

// A chapter or nav document: XHTML as XML, or, when it is not well-formed
// (some books carry HTML), as HTML. `lenient` says which.
export function parseMarkup(text: string, path: string): Document & { lenient?: boolean } {
	try {
		return parseXml(text, path);
	} catch {
		const doc: Document & { lenient?: boolean } = new DOMParser().parseFromString(text, "text/html");
		doc.lenient = true;
		return doc;
	}
}

// XMLSerializer drops the XML declaration (jsdom) or writes its own
// (Chromium), and the final newline; the file's own declaration, the space
// after it and its trailing space are kept.
export function serializeXml(doc: Document, original: string) {
	const text = new XMLSerializer().serializeToString(doc).replace(/^<\?xml[^?]*\?>\s*/, "");
	const source = original.replace(/^﻿/, "");
	const head = source.match(/^\s*<\?xml[^?]*\?>\s*/)?.[0] ?? "";
	const tail = source.match(/\s*$/)?.[0] ?? "";
	return head + text.trimEnd() + tail;
}

const STORED = /\.(jpe?g|png|gif|webp|avif|woff2?|mp3|m4a|mp4|ogg|webm|zip)$/i;

const TYPES: Record<string, string> = {
	xhtml: "application/xhtml+xml",
	html: "application/xhtml+xml",
	htm: "application/xhtml+xml",
	css: "text/css",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	svg: "image/svg+xml",
	webp: "image/webp",
	ttf: "font/ttf",
	otf: "font/otf",
	woff: "font/woff",
	woff2: "font/woff2",
	ncx: "application/x-dtbncx+xml",
	mp3: "audio/mpeg",
	mp4: "video/mp4",
};

export function guessMediaType(path: string) {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	return TYPES[ext] ?? "application/octet-stream";
}
