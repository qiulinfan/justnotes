// Page operations and document info on a PDF's bytes, through pdf-lib
// (@cantoo/pdf-lib, the maintained fork). Each takes the file's bytes and
// returns the new file's; the view (pdf-view.ts) writes them and reloads.
// Pages that stay keep their objects, so their annotations, links and form
// fields stay with them; only copies (duplicates, pages from another PDF)
// are new objects. No UI here.
import { degrees, PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "@cantoo/pdf-lib";

const INHERITABLE = ["Resources", "MediaBox", "CropBox", "Rotate"];

export interface PdfInfo {
	title: string;
	author: string;
	subject: string;
	keywords: string;
}

export const INFO_FIELDS: (keyof PdfInfo)[] = ["title", "author", "subject", "keywords"];

async function open(bytes: Uint8Array) {
	try {
		return await PDFDocument.load(bytes, { updateMetadata: false });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(/encrypt/i.test(message) ? "The PDF is encrypted; its pages cannot be changed" : message);
	}
}

const save = (doc: PDFDocument) => doc.save();

function checkIndices(doc: PDFDocument, indices: number[]) {
	const count = doc.getPageCount();
	for (const i of indices) if (!Number.isInteger(i) || i < 0 || i >= count) throw new Error(`No page ${i + 1} in a ${count}-page document`);
}

// Turns pages by a multiple of 90 degrees, clockwise for a positive delta.
export async function rotatePages(bytes: Uint8Array, indices: number[], delta: number) {
	const doc = await open(bytes);
	checkIndices(doc, indices);
	for (const i of new Set(indices)) {
		const page = doc.getPage(i);
		const angle = (((page.getRotation().angle + delta) % 360) + 360) % 360;
		page.setRotation(degrees(angle));
	}
	return save(doc);
}

export async function deletePages(bytes: Uint8Array, indices: number[]) {
	const doc = await open(bytes);
	checkIndices(doc, indices);
	const unique = [...new Set(indices)].sort((a, b) => b - a);
	if (unique.length >= doc.getPageCount()) throw new Error("A PDF needs at least one page");
	for (const i of unique) doc.removePage(i);
	return save(doc);
}

// `order` lists every page's current index once, in the new order.
export async function reorderPages(bytes: Uint8Array, order: number[]) {
	const doc = await open(bytes);
	const count = doc.getPageCount();
	if (order.length !== count || new Set(order).size !== count) throw new Error("The new order must list every page once");
	checkIndices(doc, order);
	// The page tree is rewritten flat, in the new order (pdf-lib corrupts its
	// counts when a page it removed goes back in). What a page inherited from
	// the intermediate nodes moves onto the page first.
	const pages = doc.getPages();
	for (const page of pages) {
		for (const key of INHERITABLE) {
			const name = PDFName.of(key);
			const value = page.node.getInheritableAttribute(name);
			if (value && !page.node.get(name)) page.node.set(name, value);
		}
	}
	const rootRef = doc.catalog.get(PDFName.of("Pages"));
	const root = doc.catalog.Pages();
	root.set(PDFName.of("Kids"), doc.context.obj(order.map((i) => pages[i].ref)));
	root.set(PDFName.of("Count"), PDFNumber.of(count));
	if (rootRef) for (const page of pages) page.node.set(PDFName.of("Parent"), rootRef);
	return save(doc);
}

// The pages at `indices` moved, in their order, to before the page now at
// `target` (count: to the end), as a drag in a list of thumbnails does.
export function movedOrder(count: number, indices: number[], target: number) {
	const moving = [...new Set(indices)].sort((a, b) => a - b);
	const rest = Array.from({ length: count }, (_, i) => i).filter((i) => !moving.includes(i));
	const at = rest.filter((i) => i < target).length;
	return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

// Copies of the pages, each right after its original.
export async function duplicatePages(bytes: Uint8Array, indices: number[]) {
	const doc = await open(bytes);
	checkIndices(doc, indices);
	const unique = [...new Set(indices)].sort((a, b) => b - a);
	const copies = await doc.copyPages(doc, unique);
	unique.forEach((i, k) => doc.insertPage(i + 1, copies[k]));
	return save(doc);
}

// A blank page at `at`, the size of the page it follows (else the first).
export async function insertBlankPage(bytes: Uint8Array, at: number) {
	const doc = await open(bytes);
	const count = doc.getPageCount();
	const index = Math.max(0, Math.min(count, at));
	const model = doc.getPage(Math.max(0, Math.min(count - 1, index - 1)));
	const { width, height } = model.getSize();
	doc.insertPage(index, [width, height]);
	return save(doc);
}

// Another PDF's pages (all, or those at `pages`) inserted at `at`.
export async function insertPdf(bytes: Uint8Array, other: Uint8Array, at: number, pages?: number[]) {
	const doc = await open(bytes);
	const source = await open(other);
	const indices = pages ?? source.getPageIndices();
	checkIndices(source, indices);
	const copies = await doc.copyPages(source, indices);
	const index = Math.max(0, Math.min(doc.getPageCount(), at));
	copies.forEach((page, k) => doc.insertPage(index + k, page));
	return save(doc);
}

// A new PDF of the pages at `indices`, in that order.
export async function extractPages(bytes: Uint8Array, indices: number[]) {
	const source = await open(bytes);
	checkIndices(source, indices);
	const doc = await PDFDocument.create();
	for (const page of await doc.copyPages(source, indices)) doc.addPage(page);
	const title = source.getTitle();
	if (title) doc.setTitle(title);
	return save(doc);
}

export async function readInfo(bytes: Uint8Array): Promise<PdfInfo> {
	const doc = await open(bytes);
	return { title: doc.getTitle() ?? "", author: doc.getAuthor() ?? "", subject: doc.getSubject() ?? "", keywords: doc.getKeywords() ?? "" };
}

// Writes the changed fields; the modification date becomes now.
export async function writeInfo(bytes: Uint8Array, info: Partial<PdfInfo>, now = new Date()) {
	const doc = await open(bytes);
	if (info.title !== undefined) doc.setTitle(info.title.trim());
	if (info.author !== undefined) doc.setAuthor(info.author.trim());
	if (info.subject !== undefined) doc.setSubject(info.subject.trim());
	if (info.keywords !== undefined) {
		doc.setKeywords(
			info.keywords
				.split(/[,;]/)
				.map((k) => k.trim())
				.filter(Boolean),
		);
	}
	doc.setModificationDate(now);
	return save(doc);
}

// --- Annotations ----------------------------------------------------------

export interface PdfAnnotation {
	// Which one on its page (its place in /Annots), and its kind.
	page: number;
	index: number;
	subtype: string;
	contents: string;
	// [x1, y1, x2, y2] in PDF points.
	rect: number[];
}

// Kinds the notes list leaves out: links and form fields are the
// document's own, popups belong to the annotation they open from.
const UNLISTED = new Set(["Link", "Widget", "Popup"]);

const text = (value: unknown) => (value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : "");

function annots(doc: PDFDocument, page: number) {
	const node = doc.getPage(page).node;
	const list = node.lookupMaybe(PDFName.of("Annots"), PDFArray);
	return list ?? null;
}

export async function listAnnotations(bytes: Uint8Array): Promise<PdfAnnotation[]> {
	const doc = await open(bytes);
	const out: PdfAnnotation[] = [];
	for (let page = 0; page < doc.getPageCount(); page++) {
		const list = annots(doc, page);
		if (!list) continue;
		for (let index = 0; index < list.size(); index++) {
			const dict = list.lookupMaybe(index, PDFDict);
			if (!dict) continue;
			const subtype = dict.lookupMaybe(PDFName.of("Subtype"), PDFName)?.decodeText() ?? "";
			if (UNLISTED.has(subtype)) continue;
			const rect = (dict.lookupMaybe(PDFName.of("Rect"), PDFArray)?.asArray() ?? []).map((n) => (n instanceof PDFNumber ? n.asNumber() : 0));
			out.push({ page, index, subtype, contents: text(dict.lookup(PDFName.of("Contents"))), rect });
		}
	}
	return out;
}

// A sticky note (a Text annotation, shown as an icon that opens its text)
// with its top left corner at (x, y) on page `page`.
export async function addNote(bytes: Uint8Array, page: number, x: number, y: number, contents: string, now = new Date()) {
	const doc = await open(bytes);
	checkIndices(doc, [page]);
	const dict = doc.context.obj({
		Type: "Annot",
		Subtype: "Text",
		Rect: [x, y - 20, x + 20, y],
		Contents: PDFHexString.fromText(contents),
		Name: "Comment",
		C: [1, 0.82, 0],
		F: 4,
		M: PDFString.fromDate(now),
	});
	const ref = doc.context.register(dict);
	const node = doc.getPage(page).node;
	const list = annots(doc, page);
	if (list) list.push(ref);
	else node.set(PDFName.of("Annots"), doc.context.obj([ref]));
	return save(doc);
}

function find(doc: PDFDocument, target: Pick<PdfAnnotation, "page" | "index">) {
	checkIndices(doc, [target.page]);
	const list = annots(doc, target.page);
	const ref = list?.get(target.index);
	const dict = list?.lookupMaybe(target.index, PDFDict);
	if (!list || !dict) throw new Error("That annotation is no longer there");
	return { list, ref, dict };
}

export async function setAnnotationContents(bytes: Uint8Array, target: Pick<PdfAnnotation, "page" | "index">, contents: string, now = new Date()) {
	const doc = await open(bytes);
	const { dict } = find(doc, target);
	dict.set(PDFName.of("Contents"), PDFHexString.fromText(contents));
	dict.set(PDFName.of("M"), PDFString.fromDate(now));
	return save(doc);
}

// Removes an annotation and the popup it opens.
export async function deleteAnnotation(bytes: Uint8Array, target: Pick<PdfAnnotation, "page" | "index">) {
	const doc = await open(bytes);
	const { list, ref, dict } = find(doc, target);
	const popup = dict.get(PDFName.of("Popup"));
	for (let i = list.size() - 1; i >= 0; i--) {
		const entry = list.get(i);
		if (i === target.index || (popup instanceof PDFRef && entry === popup)) list.remove(i);
	}
	if (ref instanceof PDFRef) doc.context.delete(ref);
	if (popup instanceof PDFRef) doc.context.delete(popup);
	return save(doc);
}

// The annotation in `bytes` that `annot` was when it was listed: same page,
// kind, place and text (the list may be older than the file, and places in
// /Annots shift when pdf.js's editors remove or add annotations).
export async function relocate(bytes: Uint8Array, annot: PdfAnnotation): Promise<PdfAnnotation> {
	const same = (a: PdfAnnotation) =>
		a.page === annot.page && a.subtype === annot.subtype && a.contents === annot.contents && a.rect.length === annot.rect.length && a.rect.every((v, i) => Math.abs(v - annot.rect[i]) < 0.01);
	const list = await listAnnotations(bytes);
	const found = list.find((a) => same(a) && a.index === annot.index) ?? list.find(same);
	if (!found) throw new Error("That annotation is no longer there");
	return found;
}
