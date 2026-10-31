import { describe, expect, test } from "bun:test";
import { currentAlign, currentZoom, embedAsHtml, findImageRefs, setHtmlAlign, setHtmlZoom, zoomImageSource } from "../src/api/image-menu";

// What the zoom menu writes into the note.
describe("setHtmlZoom", () => {
	test("rewrites only the zoom value, keeping its spacing, other declarations and attributes", () => {
		expect(setHtmlZoom('<img src="a b.png" alt="a b" style="zoom:50%;" />', 33)).toBe('<img src="a b.png" alt="a b" style="zoom:33%;" />');
		expect(setHtmlZoom('<img src="x.png" style="zoom: 67%;" width="100">', 25)).toBe('<img src="x.png" style="zoom: 25%;" width="100">');
		expect(setHtmlZoom("<img src='x.png' style='border: 1px solid; zoom:80%'>", 50)).toBe("<img src='x.png' style='border: 1px solid; zoom:50%'>");
	});

	test("adds a style where none is, before the tag's end", () => {
		expect(setHtmlZoom('<img src="x.png" alt="x"  />', 75)).toBe('<img src="x.png" alt="x" style="zoom:75%;" />');
		expect(setHtmlZoom('<img src="x.png">', 50)).toBe('<img src="x.png" style="zoom:50%;">');
		expect(setHtmlZoom('<img src="x.png" style="border:0">', 50)).toBe('<img src="x.png" style="zoom:50%; border:0">');
	});

	test("reset removes the zoom, and the style attribute when nothing else is in it", () => {
		expect(setHtmlZoom('<img src="x.png" alt="x" style="zoom:50%;" />', null)).toBe('<img src="x.png" alt="x" />');
		expect(setHtmlZoom('<img src="x.png" style="zoom:50%; border:0">', null)).toBe('<img src="x.png" style="border:0">');
		expect(setHtmlZoom('<img src="x.png">', null)).toBe('<img src="x.png">');
	});
});

describe("zoomImageSource", () => {
	test("embeds get a width from the natural width, replacing a size and keeping alt text", () => {
		expect(zoomImageSource("![[x.png]]", "wikilink", 50, 801)).toBe("![[x.png|401]]");
		expect(zoomImageSource("![[x.png|300x200]]", "wikilink", 25, 800)).toBe("![[x.png|200]]");
		expect(zoomImageSource("![[x.png|a cat|300]]", "wikilink", 100, 640)).toBe("![[x.png|a cat|640]]");
		expect(zoomImageSource("![](x%20y.png)", "markdown", 75, 400)).toBe("![|300](x%20y.png)");
		expect(zoomImageSource("![a cat|300](x.png)", "markdown", 50, 1000)).toBe("![a cat|500](x.png)");
	});

	test("reset drops the size and nothing else", () => {
		expect(zoomImageSource("![[x.png|a cat|300]]", "wikilink", null, 640)).toBe("![[x.png|a cat]]");
		expect(zoomImageSource("![[x.png|300]]", "wikilink", null, 640)).toBe("![[x.png]]");
		expect(zoomImageSource("![|300](x.png)", "markdown", null, 640)).toBe("![](x.png)");
	});

	test("an image whose natural width is unknown is left alone", () => {
		expect(zoomImageSource("![[x.png]]", "wikilink", 50, 0)).toBe("![[x.png]]");
	});
});

describe("currentZoom", () => {
	test("reads the zoom style or the width's share of the natural width", () => {
		expect(currentZoom('<img src="x" style="zoom: 33%;">', "html", 0)).toBe(33);
		expect(currentZoom("![[x.png|a|400]]", "wikilink", 800)).toBe(50);
		expect(currentZoom("![](x.png)", "markdown", 800)).toBe(null);
	});
});

describe("findImageRefs", () => {
	test("finds the three kinds in order, with their targets, skipping inline code", () => {
		const text = 'a <img src="note-assets/a b.png" alt="x"> `![[no.png]]` ![[y.png|200]] ![alt](<p q.png> "t") ![](z.png)';
		expect(findImageRefs(text).map((r) => [r.kind, r.target, text.slice(r.from, r.to)])).toEqual([
			["html", "note-assets/a b.png", '<img src="note-assets/a b.png" alt="x">'],
			["wikilink", "y.png", "![[y.png|200]]"],
			["markdown", "p q.png", '![alt](<p q.png> "t")'],
			["markdown", "z.png", "![](z.png)"],
		]);
	});
});

describe("setHtmlAlign", () => {
	test("writes a block image with auto margins, keeping zoom and attributes, and replaces an earlier alignment", () => {
		const centered = setHtmlAlign('<img src="a b.png" alt="a b" style="zoom:50%;" />', "center");
		expect(centered).toBe('<img src="a b.png" alt="a b" style="zoom:50%; display:block; margin:0 auto;" />');
		expect(setHtmlAlign(centered, "right")).toBe('<img src="a b.png" alt="a b" style="zoom:50%; display:block; margin:0 0 0 auto;" />');
		expect(setHtmlAlign('<img src="x.png">', "left")).toBe('<img src="x.png" style="display:block; margin:0 auto 0 0;">');
	});

	test("reset removes only the alignment, and an emptied style", () => {
		expect(setHtmlAlign('<img src="x.png" style="zoom: 33%; display:block; margin:0 auto;">', null)).toBe('<img src="x.png" style="zoom: 33%;">');
		expect(setHtmlAlign('<img src="x.png" style="display:block; margin:0 auto;" />', null)).toBe('<img src="x.png" />');
		expect(setHtmlAlign('<img src="x.png" style="zoom:50%;">', null)).toBe('<img src="x.png" style="zoom:50%;">');
	});

	test("currentAlign reads it back for the menu's check", () => {
		expect(currentAlign(setHtmlAlign('<img src="x.png">', "right"), "html")).toBe("right");
		expect(currentAlign('<img src="x.png" style="margin-left:auto">', "html")).toBe(null);
	});
});

describe("embedAsHtml", () => {
	test("an embed becomes an <img> with its size and alt text, or the file name as alt", () => {
		expect(embedAsHtml("![[red pic.png|300x200]]", "wikilink", "../red pic.png", "red pic")).toBe('<img src="../red pic.png" alt="red pic" width="300" height="200" />');
		expect(embedAsHtml("![[x.png|a cat|300]]", "wikilink", "x.png", "x")).toBe('<img src="x.png" alt="a cat" width="300" />');
		expect(embedAsHtml("![a cat](x%20y.png)", "markdown", "x y.png", "x y")).toBe('<img src="x y.png" alt="a cat" />');
	});
});
