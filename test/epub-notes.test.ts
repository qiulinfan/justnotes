import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
beforeAll(() => {
	Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
});

const { noteFor } = await import("../src/renderer/epub/notes");

const page = (body: string) =>
	new dom.window.DOMParser().parseFromString(
		`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>t</title></head><body>${body}</body></html>`,
		"application/xhtml+xml",
	) as unknown as Document;

// The note the link with id `ref` points at, as its text, or null.
function note(doc: Document, ref: string, at = "text/ch1.xhtml", targetDoc = doc, targetPath = at) {
	const link = doc.querySelector(`[data-ref="${ref}"]`) ?? doc.getElementById(ref);
	if (!link) throw new Error(`no link ${ref}`);
	const fragment = (link.getAttribute("href") ?? "").split("#")[1];
	const target = targetDoc.getElementById(fragment);
	if (!target) throw new Error(`no target ${fragment}`);
	const found = noteFor(link, at, target, targetPath);
	return found ? found.content.textContent?.replace(/\s+/g, " ").trim() : null;
}

describe("notes", () => {
	test("EPUB 3: a noteref and its aside", () => {
		const doc = page(`<p>Text<a epub:type="noteref" id="r1" href="#n1">1</a> goes on.</p>
<aside epub:type="footnote" id="n1"><p>First paragraph.</p><p>Second paragraph.</p></aside>`);
		expect(note(doc, "r1")).toBe("First paragraph.Second paragraph.");
	});

	test("a converter's note: a link back from a block of its own, without the mark", () => {
		const doc = page(`<p>The temple<span id="fn-1-back"><a class="_idfootnotelink" id="a" href="ch1.xhtml#a-">a</a></span> stood.</p>
<hr/><div class="notes-area"><div id="fn-1"><p><a class="_idfootnotelink" id="a-" href="ch1.xhtml#a">a</a> A temple in the north.</p></div>
<div id="fn-2"><p><a class="_idfootnotelink" id="b-" href="ch1.xhtml#b">b</a> Another note.</p></div></div>`);
		expect(note(doc, "a")).toBe("A temple in the north.");
	});

	test("an empty anchor beside the mark, a note paragraph linking back to it", () => {
		const doc = page(`<p>A book<a id="w1"></a><a data-ref="x" href="../text/ch1.xhtml#m1"><sup>[1]</sup></a>, VI</p>
<p>Body text.</p><hr/><p class="note"><a id="m1"></a><a href="../text/ch1.xhtml#w1">[1]</a> A children's novel.</p>`);
		expect(note(doc, "x")).toBe("A children's novel.");
	});

	test("notes as a definition list: the term is the mark, its definitions the note", () => {
		const text = page(`<p>Words<sup id="back_note_1" class="noteref"><a data-ref="x" href="notes.xhtml#note_1">1</a></sup> more.</p>`);
		const notes = page(`<dl class="notes"><dt id="note_1">[<a href="ch1.xhtml#back_note_1">←1</a>]</dt><dd><p>The first note.</p></dd>
<dt id="note_2">[<a href="ch1.xhtml#back_note_2">←2</a>]</dt><dd><p>The second note.</p></dd></dl>`);
		expect(note(text, "x", "text/ch1.xhtml", notes, "text/notes.xhtml")).toBe("The first note.");
	});

	test("one definition list per note: the link back and its brackets go", () => {
		const text = page(`<p>Words<sup>[</sup><sup><a data-ref="x" href="n.xhtml#note_9"><sup id="back_note_9">9</sup></a></sup><sup>]</sup>.</p>`);
		const notes = page(`<dl id="note_9" class="footnote"><dt>[<a href="ch1.xhtml#back_note_9">←9</a>]</dt><dd><p>Ninth note.</p></dd></dl>`);
		const link = text.querySelector('[data-ref="x"]')!;
		const found = noteFor(link, "text/ch1.xhtml", notes.getElementById("note_9")!, "text/n.xhtml");
		expect(found?.content.textContent?.replace(/\s+/g, " ").trim()).toBe("Ninth note.");
		expect(found?.content.querySelector("dt")).toBeNull();
	});

	test("empty brackets a converter left at a note's start go", () => {
		const text = page(`<p>Words<sup><a data-ref="x" href="n.xhtml#note_1"><sup id="back_note_1">1</sup></a></sup>.</p>`);
		const notes = page(`<dl id="note_1" class="footnote"><dt>[<a href="ch1.xhtml#back_note_1">←1</a>]</dt><dd><p><sup>[</sup><sup></sup><sup>]</sup><span> </span><span>A place name.</span></p></dd></dl>`);
		expect(note(text, "x", "text/ch1.xhtml", notes, "text/n.xhtml")).toBe("A place name.");
	});

	test("from a note back to its mark: the passage, the mark's brackets gone with it", () => {
		const text = page(`<p id="p1">A letter<sup>[</sup><a href="n.xhtml#note_4"><sup id="back_note_4">4</sup></a><sup>]</sup> to a friend.</p>`);
		const notes = page(`<dl id="note_4" class="footnote"><dt>[<a data-ref="x" href="ch1.xhtml#back_note_4">←4</a>]</dt><dd><p>A poet.</p></dd></dl>`);
		expect(note(notes, "x", "text/n.xhtml", text, "text/ch1.xhtml")).toBe("A letter to a friend.");
	});

	test("the copy has no ids, so the page's own stay unique", () => {
		const doc = page(`<p>x<a epub:type="noteref" id="r1" href="#n1">1</a></p><aside epub:type="footnote" id="n1"><p id="inner">Note.</p></aside>`);
		const found = noteFor(doc.getElementById("r1")!, "a.xhtml", doc.getElementById("n1")!, "a.xhtml");
		expect(found?.content.querySelectorAll("[id]").length).toBe(0);
		expect(doc.getElementById("inner")).not.toBeNull();
	});

	test("a chapter heading's link to the contents is no note", () => {
		const doc = page(`<h1 id="c72"><a id="go" href="contents.xhtml#c_72">72</a></h1>`);
		const contents = page(`<div class="toc_chap" id="c_72"><a href="ch1.xhtml">Chapter 72</a></div>`);
		expect(note(doc, "go", "text/ch1.xhtml", contents, "text/contents.xhtml")).toBeNull();
	});

	test("a contents link to a heading is no note", () => {
		const contents = page(`<p><a id="go" href="ch1.xhtml#s1">1</a></p>`);
		const chapter = page(`<h2 id="s1">One</h2><p>Text.</p>`);
		expect(note(contents, "go", "text/contents.xhtml", chapter, "text/ch1.xhtml")).toBeNull();
	});

	test("a link with words to a passage is no note", () => {
		const doc = page(`<p>See <a id="go" href="#later">the later discussion</a>.</p><p id="later">Later, at length.</p>`);
		expect(note(doc, "go")).toBeNull();
	});

	test("a bare numbered mark and a note in an endnotes list", () => {
		const doc = page(`<p>Claim<sup><a id="go" href="#en3">3</a></sup>.</p><ol><li id="en3">Source for the claim. <a href="#go">↩</a></li></ol>`);
		expect(note(doc, "go")).toBe("Source for the claim.");
	});
});
