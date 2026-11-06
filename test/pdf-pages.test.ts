import { describe, expect, test } from "bun:test";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import {
	addNote,
	deleteAnnotation,
	deletePages,
	listAnnotations,
	relocate,
	setAnnotationContents,
	duplicatePages,
	extractPages,
	insertBlankPage,
	insertPdf,
	movedOrder,
	readInfo,
	reorderPages,
	rotatePages,
	writeInfo,
} from "../src/renderer/pdf/pages";

// A PDF whose page i is 100+i points wide and says "Page i+1"; the first
// page carries an annotation, to show that pages keep theirs.
async function sample(count: number, title = "Sample") {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let i = 0; i < count; i++) {
		const page = doc.addPage([100 + i, 200]);
		page.drawText(`Page ${i + 1}`, { x: 10, y: 100, size: 12, font });
	}
	const annot = doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 10, 10], Contents: PDFString.of("note") });
	doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
	doc.setTitle(title);
	return doc.save();
}

// Loading without updateMetadata, or pdf-lib stamps the dates itself.
const load = (bytes: Uint8Array) => PDFDocument.load(bytes, { updateMetadata: false });
const widths = async (bytes: Uint8Array) => (await load(bytes)).getPages().map((p) => Math.round(p.getWidth()));
// pdf-lib gives every page an Annots array, empty when it has none.
const hasAnnot = (doc: PDFDocument, i: number) => (doc.getPage(i).node.Annots()?.size() ?? 0) > 0;

describe("PDF page operations", () => {
	test("rotation adds up and wraps, per page", async () => {
		let bytes = await rotatePages(await sample(3), [0, 2], 90);
		bytes = await rotatePages(bytes, [2], 90);
		bytes = await rotatePages(bytes, [0], -180);
		const doc = await load(bytes);
		expect(doc.getPages().map((p) => p.getRotation().angle)).toEqual([270, 0, 180]);
	});

	test("deleting pages keeps the rest in order and refuses to empty the file", async () => {
		const bytes = await deletePages(await sample(5), [3, 1, 1]);
		expect(await widths(bytes)).toEqual([100, 102, 104]);
		await expect(deletePages(await sample(2), [0, 1])).rejects.toThrow("at least one page");
		await expect(deletePages(await sample(2), [2])).rejects.toThrow("No page 3");
	});

	test("reordering moves the pages themselves, annotations included", async () => {
		const bytes = await reorderPages(await sample(4), [2, 0, 3, 1]);
		expect(await widths(bytes)).toEqual([102, 100, 103, 101]);
		const doc = await load(bytes);
		expect(hasAnnot(doc, 1)).toBe(true);
		expect(hasAnnot(doc, 0)).toBe(false);
		await expect(reorderPages(await sample(3), [0, 0, 1])).rejects.toThrow("every page once");
	});

	test("movedOrder places a dragged selection before the target", () => {
		expect(movedOrder(5, [0], 3)).toEqual([1, 2, 0, 3, 4]);
		expect(movedOrder(5, [3, 4], 0)).toEqual([3, 4, 0, 1, 2]);
		expect(movedOrder(5, [1, 3], 5)).toEqual([0, 2, 4, 1, 3]);
		expect(movedOrder(4, [2], 2)).toEqual([0, 1, 2, 3]);
	});

	test("duplicates follow their originals", async () => {
		const bytes = await duplicatePages(await sample(3), [0, 2]);
		expect(await widths(bytes)).toEqual([100, 100, 101, 102, 102]);
	});

	test("a blank page takes the size of the page before it", async () => {
		expect(await widths(await insertBlankPage(await sample(3), 2))).toEqual([100, 101, 101, 102]);
		expect(await widths(await insertBlankPage(await sample(3), 0))).toEqual([100, 100, 101, 102]);
		expect(await widths(await insertBlankPage(await sample(2), 99))).toEqual([100, 101, 101]);
	});

	test("another PDF's pages go in at a position", async () => {
		const other = await reorderPages(await sample(2), [1, 0]);
		expect(await widths(await insertPdf(await sample(3), other, 1))).toEqual([100, 101, 100, 101, 102]);
		expect(await widths(await insertPdf(await sample(1), other, 1, [0]))).toEqual([100, 101]);
	});

	test("extraction makes a new file of the chosen pages", async () => {
		const bytes = await extractPages(await sample(4, "Book"), [3, 1]);
		expect(await widths(bytes)).toEqual([103, 101]);
		expect((await readInfo(bytes)).title).toBe("Book");
	});

	test("document info reads and writes", async () => {
		const bytes = await writeInfo(await sample(1), { title: " New title ", author: "Borges", keywords: "a, b; c" }, new Date("2026-11-05T00:00:00Z"));
		expect(await readInfo(bytes)).toEqual({ title: "New title", author: "Borges", subject: "", keywords: "a b c" });
		expect((await load(bytes)).getModificationDate()?.toISOString()).toBe("2026-11-05T00:00:00.000Z");
	});
});

describe("PDF notes", () => {
	test("notes are added, listed, edited and deleted; links and fields are not listed", async () => {
		let bytes = await sample(2);
		// The sample's first page already has a Text annotation ("note").
		expect((await listAnnotations(bytes)).map((a) => [a.page, a.subtype, a.contents])).toEqual([[0, "Text", "note"]]);
		bytes = await addNote(bytes, 1, 30, 150, "Ünïcode 注释", new Date("2026-11-05T00:00:00Z"));
		const listed = await listAnnotations(bytes);
		expect(listed.map((a) => [a.page, a.subtype, a.contents])).toEqual([
			[0, "Text", "note"],
			[1, "Text", "Ünïcode 注释"],
		]);
		expect(listed[1].rect).toEqual([30, 130, 50, 150]);
		bytes = await setAnnotationContents(bytes, listed[1], "edited");
		expect((await listAnnotations(bytes))[1].contents).toBe("edited");
		bytes = await deleteAnnotation(bytes, listed[0]);
		expect((await listAnnotations(bytes)).map((a) => a.contents)).toEqual(["edited"]);
		await expect(deleteAnnotation(bytes, { page: 0, index: 5 })).rejects.toThrow("no longer there");
	});
});

test("an annotation listed earlier is found again after the ones before it went", async () => {
	let bytes = await addNote(await addNote(await sample(1), 0, 10, 100, "first"), 0, 50, 100, "second");
	const listed = await listAnnotations(bytes);
	const second = listed.find((a) => a.contents === "second")!;
	expect(second.index).toBe(2);
	// The sample's own note and "first" go (as pdf.js's editors may remove them).
	bytes = await deleteAnnotation(bytes, listed[0]);
	bytes = await deleteAnnotation(bytes, (await listAnnotations(bytes))[0]);
	const found = await relocate(bytes, second);
	expect(found.index).toBe(0);
	expect(found.contents).toBe("second");
	bytes = await deleteAnnotation(bytes, found);
	await expect(relocate(bytes, second)).rejects.toThrow("no longer there");
});
