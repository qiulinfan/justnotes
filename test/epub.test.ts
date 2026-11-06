import { beforeAll, describe, expect, test } from "bun:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { JSDOM } from "jsdom";

// book.ts and chapter.ts parse with the page's DOMParser and XMLSerializer.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
beforeAll(() => {
	Object.assign(globalThis, { DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer });
});

const { EpubBook, resolvePath } = await import("../src/renderer/epub/book");
const { commitBody, loadChapter, rewriteCss } = await import("../src/renderer/epub/chapter");

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF3 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:uuid:1</dc:identifier>
    <dc:title>Ficciones</dc:title>
    <dc:creator>Borges</dc:creator>
    <dc:language>es</dc:language>
    <meta property="dcterms:modified">2020-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="Text/ch%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="Styles/book.css" media-type="text/css"/>
    <item id="img" href="Images/cover.jpg" media-type="image/jpeg"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`;

const NAV = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>nav</title></head><body>
<nav epub:type="landmarks"><ol><li><a href="Text/ch2.xhtml">Not this one</a></li></ol></nav>
<nav epub:type="toc"><ol>
  <li><a href="Text/ch%201.xhtml">Part One</a>
    <ol><li><a href="Text/ch2.xhtml#tlon">Tlön, Uqbar</a></li></ol></li>
  <li><span>Unlinked</span></li>
</ol></nav></body></html>`;

const CH1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>One</title><link rel="stylesheet" type="text/css" href="../Styles/book.css"/></head>
<body class="c"><section epub:type="chapter"><h1>Part One</h1><p>First<br/>line.</p><img src="../Images/cover.jpg" alt="cover"/><div/><p style="background: url(../Images/cover.jpg)">bg</p></section></body>
</html>`;

const CH2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h2 id="tlon">Tlön</h2><p>Text &amp; more.</p></body></html>`;

const CSS = `@import "fonts.css";\nbody { background: url('../Images/cover.jpg') }\n.x { background: url(https://example.com/a.png) }`;

function epub(files: Record<string, string | Uint8Array>) {
	const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
	for (const [path, data] of Object.entries(files)) entries[path] = [typeof data === "string" ? strToU8(data) : data, { level: path === "mimetype" ? 0 : 6 }];
	return zipSync(entries);
}

const COVER = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const book3 = () =>
	EpubBook.read(
		epub({
			mimetype: "application/epub+zip",
			"META-INF/container.xml": CONTAINER,
			"OEBPS/content.opf": OPF3,
			"OEBPS/nav.xhtml": NAV,
			"OEBPS/Text/ch 1.xhtml": CH1,
			"OEBPS/Text/ch2.xhtml": CH2,
			"OEBPS/Styles/book.css": CSS,
			"OEBPS/Styles/fonts.css": "p { color: red }",
			"OEBPS/Images/cover.jpg": COVER,
		}),
	);

// The zip's local headers in order: name and compression method.
function zipOrder(data: Uint8Array) {
	const out: { name: string; method: number }[] = [];
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let i = 0;
	while (i + 30 <= data.length && view.getUint32(i, true) === 0x04034b50) {
		const method = view.getUint16(i + 8, true);
		const size = view.getUint32(i + 18, true);
		const nameLen = view.getUint16(i + 26, true);
		const extraLen = view.getUint16(i + 28, true);
		out.push({ name: strFromU8(data.subarray(i + 30, i + 30 + nameLen)), method });
		i += 30 + nameLen + extraLen + size;
	}
	return out;
}

describe("EpubBook", () => {
	test("reads the spine, the manifest's paths and the EPUB 3 nav's toc", () => {
		const book = book3();
		expect(book.opfPath).toBe("OEBPS/content.opf");
		expect(book.spine.map((s) => s.path)).toEqual(["OEBPS/Text/ch 1.xhtml", "OEBPS/Text/ch2.xhtml"]);
		expect(book.toc).toEqual([
			{
				label: "Part One",
				path: "OEBPS/Text/ch 1.xhtml",
				fragment: "",
				children: [{ label: "Tlön, Uqbar", path: "OEBPS/Text/ch2.xhtml", fragment: "tlon", children: [] }],
			},
			{ label: "Unlinked", path: "", fragment: "", children: [] },
		]);
		expect(book.metadata()).toEqual({ title: "Ficciones", creator: "Borges", language: "es", publisher: "", description: "" });
	});

	test("reads an EPUB 2 NCX when there is no nav", () => {
		const opf = OPF3.replace(' properties="nav"', "")
			.replace('<item id="nav" href="nav.xhtml"', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="unused" href="nav.xhtml"')
			.replace("<spine>", '<spine toc="ncx">');
		const ncx = `<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
<navPoint id="a"><navLabel><text>One</text></navLabel><content src="Text/ch%201.xhtml"/>
<navPoint id="b"><navLabel><text> Two </text></navLabel><content src="Text/ch2.xhtml#tlon"/></navPoint></navPoint>
</navMap></ncx>`;
		const book = EpubBook.read(
			epub({ mimetype: "application/epub+zip", "META-INF/container.xml": CONTAINER, "OEBPS/content.opf": opf, "OEBPS/toc.ncx": ncx, "OEBPS/nav.xhtml": NAV, "OEBPS/Text/ch 1.xhtml": CH1, "OEBPS/Text/ch2.xhtml": CH2 }),
		);
		expect(book.toc).toEqual([{ label: "One", path: "OEBPS/Text/ch 1.xhtml", fragment: "", children: [{ label: "Two", path: "OEBPS/Text/ch2.xhtml", fragment: "tlon", children: [] }] }]);
	});

	test("writes mimetype first and stored, keeps untouched entries' bytes and order", () => {
		const book = book3();
		const out = book.toBytes();
		const order = zipOrder(out);
		expect(order[0]).toEqual({ name: "mimetype", method: 0 });
		expect(order.map((e) => e.name)).toEqual([
			"mimetype",
			"META-INF/container.xml",
			"OEBPS/content.opf",
			"OEBPS/nav.xhtml",
			"OEBPS/Text/ch 1.xhtml",
			"OEBPS/Text/ch2.xhtml",
			"OEBPS/Styles/book.css",
			"OEBPS/Styles/fonts.css",
			"OEBPS/Images/cover.jpg",
		]);
		expect(order.find((e) => e.name.endsWith(".jpg"))?.method).toBe(0);
		const files = unzipSync(out);
		expect(strFromU8(files["OEBPS/Text/ch 1.xhtml"])).toBe(CH1);
		expect(files["OEBPS/Images/cover.jpg"]).toEqual(COVER);
	});

	test("metadata edits change only their elements and dcterms:modified", () => {
		const book = book3();
		expect(book.setMetadata({ title: "Ficciones", creator: "Jorge Luis Borges", publisher: "Sur", language: "" }, new Date("2026-11-05T10:20:30.456Z"))).toBe(true);
		const opf = book.text(book.opfPath);
		expect(opf.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<package')).toBe(true);
		expect(opf.endsWith("</package>")).toBe(true);
		expect(opf).toContain("<dc:creator>Jorge Luis Borges</dc:creator>");
		expect(opf).toContain("<dc:publisher>Sur</dc:publisher>");
		expect(opf).not.toContain("dc:language");
		expect(opf).toContain('<meta property="dcterms:modified">2026-11-05T10:20:30Z</meta>');
		expect(opf).toContain('<dc:identifier id="id">urn:uuid:1</dc:identifier>');
		expect(book.metadata().creator).toBe("Jorge Luis Borges");
		// The edited package is still the book's: spine and toc read again.
		expect(book.spine.length).toBe(2);
		expect(book.setMetadata({ creator: "Jorge Luis Borges" })).toBe(false);
	});

	test("resolves hrefs against their folder", () => {
		expect(resolvePath("OEBPS/Text", "../Images/a%20b.png#x")).toBe("OEBPS/Images/a b.png");
		expect(resolvePath("OEBPS", "./Text/c.xhtml?q")).toBe("OEBPS/Text/c.xhtml");
		expect(resolvePath("", "../../a.css")).toBe("a.css");
	});
});

describe("chapters", () => {
	const urlFor = (path: string) => (path.startsWith("OEBPS/") ? `blob:test/${encodeURIComponent(path)}` : null);

	test("display copies point resources at served URLs; the model keeps the file's", () => {
		const book = book3();
		const chapter = loadChapter(book, "OEBPS/Text/ch 1.xhtml", urlFor);
		const img = chapter.display.getElementsByTagName("img")[0];
		expect(img.getAttribute("src")).toBe(`blob:test/${encodeURIComponent("OEBPS/Images/cover.jpg")}`);
		expect(chapter.display.getElementsByTagName("link")[0].getAttribute("href")).toBe(`blob:test/${encodeURIComponent("OEBPS/Styles/book.css")}`);
		expect(chapter.model.getElementsByTagName("img")[0].getAttribute("src")).toBe("../Images/cover.jpg");
	});

	test("stylesheets' url() and @import point at served URLs, external ones stay", () => {
		const css = rewriteCss(CSS, "OEBPS/Styles", urlFor);
		expect(css).toContain(`@import "blob:test/${encodeURIComponent("OEBPS/Styles/fonts.css")}"`);
		expect(css).toContain(`url('blob:test/${encodeURIComponent("OEBPS/Images/cover.jpg")}')`);
		expect(css).toContain("url(https://example.com/a.png)");
	});

	// The frame is an HTML document; the chapter's root is imported into it,
	// edited there, and its <body> comes back.
	function edit(chapter: ReturnType<typeof loadChapter>, change: (body: HTMLElement) => void) {
		const frame = new JSDOM("<!doctype html><html><head></head><body></body></html>").window.document;
		frame.replaceChild(frame.importNode(chapter.display.documentElement, true), frame.documentElement);
		change(frame.body);
		return commitBody(chapter, frame.body);
	}

	test("an edit writes back well-formed XHTML with the original references", () => {
		const book = book3();
		const chapter = loadChapter(book, "OEBPS/Text/ch 1.xhtml", urlFor);
		const text = edit(chapter, (body) => {
			body.getElementsByTagName("h1")[0].textContent = "Part One, revised <&>";
			const p = body.ownerDocument.createElement("p");
			p.textContent = "Added.";
			p.setAttribute("contenteditable", "true");
			body.querySelector("section")?.append(p);
		});
		expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>')).toBe(true);
		expect(text).toContain("<h1>Part One, revised &lt;&amp;&gt;</h1>");
		expect(text).toContain('<img src="../Images/cover.jpg" alt="cover"');
		expect(text).toContain('style="background: url(../Images/cover.jpg)"');
		expect(text).toContain('<body class="c"><section epub:type="chapter">');
		// Everything outside <body> keeps the file's bytes; the body inherits
		// its namespaces from <html> again.
		expect(text.slice(0, text.indexOf("<body"))).toBe(CH1.slice(0, CH1.indexOf("<body")));
		expect(text.slice(text.indexOf("</body>"))).toBe(CH1.slice(CH1.indexOf("</body>")));
		expect(text).not.toContain("<body xmlns");
		expect(text).toContain("<p>Added.</p>");
		expect(text).not.toContain("blob:");
		expect(text).not.toContain("contenteditable");
		// Parses as XML: the <br/> and the empty <div/> stayed elements.
		const doc = new DOMParser().parseFromString(text, "application/xml");
		expect(doc.getElementsByTagName("parsererror").length).toBe(0);
		expect(doc.getElementsByTagName("br").length).toBe(1);
		expect(doc.getElementsByTagName("section")[0].getElementsByTagName("p").length).toBe(3);
		book.setText(chapter.path, text);
		expect(strFromU8(unzipSync(book.toBytes())["OEBPS/Text/ch 1.xhtml"])).toBe(text);
	});

	test("a chapter that is HTML, not XHTML, is written back as XHTML", () => {
		const opf = OPF3;
		const book = EpubBook.read(
			epub({
				mimetype: "application/epub+zip",
				"META-INF/container.xml": CONTAINER,
				"OEBPS/content.opf": opf,
				"OEBPS/nav.xhtml": NAV,
				"OEBPS/Text/ch 1.xhtml": "<html><head><title>x</title></head><body><p>Broken<br>markup &nbsp; here</body></html>",
				"OEBPS/Text/ch2.xhtml": CH2,
			}),
		);
		const chapter = loadChapter(book, "OEBPS/Text/ch 1.xhtml", urlFor);
		expect(chapter.model.lenient).toBe(true);
		const text = edit(chapter, (body) => body.append("!"));
		const doc = new DOMParser().parseFromString(text, "application/xml");
		expect(doc.getElementsByTagName("parsererror").length).toBe(0);
		expect(doc.documentElement.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
		expect(doc.getElementsByTagName("body")[0].textContent).toContain("Broken");
	});
});

// A book with both contents documents: the EPUB 3 nav and an NCX.
const NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head/><docTitle><text>F</text></docTitle><navMap>
<navPoint id="p1" playOrder="1"><navLabel><text>Part One</text></navLabel><content src="Text/ch%201.xhtml"/>
<navPoint id="p2" playOrder="2"><navLabel><text>Tlön</text></navLabel><content src="Text/ch2.xhtml#tlon"/></navPoint></navPoint>
</navMap></ncx>`;

const bothTocs = () =>
	EpubBook.read(
		epub({
			mimetype: "application/epub+zip",
			"META-INF/container.xml": CONTAINER,
			"OEBPS/content.opf": OPF3.replace("<spine>", '<spine toc="ncx">').replace("<manifest>", '<manifest>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'),
			"OEBPS/nav.xhtml": NAV,
			"OEBPS/toc.ncx": NCX,
			"OEBPS/Text/ch 1.xhtml": CH1,
			"OEBPS/Text/ch2.xhtml": CH2,
			"OEBPS/Styles/book.css": CSS,
			"OEBPS/Images/cover.jpg": COVER,
		}),
	);

const ncxLabels = (book: InstanceType<typeof EpubBook>) => {
	const doc = new DOMParser().parseFromString(book.text("OEBPS/toc.ncx"), "application/xml");
	return Array.from(doc.getElementsByTagName("navPoint")).map((p) => `${p.getAttribute("playOrder")}:${p.getElementsByTagName("text")[0].textContent}`);
};
const navLabels = (book: InstanceType<typeof EpubBook>) => {
	const flat: string[] = [];
	const walk = (es: typeof book.toc, d: number) => es.forEach((e) => (flat.push(`${"-".repeat(d)}${e.label}`), walk(e.children, d + 1)));
	walk(book.toc, 0);
	return flat;
};

describe("book structure", () => {
	test("a new chapter joins the manifest, the spine and both contents", () => {
		const book = bothTocs();
		const index = book.addChapter(0, "Interlude & more");
		expect(index).toBe(1);
		const path = book.spine[1].path;
		expect(path).toBe("OEBPS/Text/chapter.xhtml");
		expect(book.spine.map((s) => s.path)).toEqual(["OEBPS/Text/ch 1.xhtml", "OEBPS/Text/chapter.xhtml", "OEBPS/Text/ch2.xhtml"]);
		const text = book.text(path);
		expect(text).toContain("<title>Interlude &amp; more</title>");
		expect(text).toContain('<link rel="stylesheet" type="text/css" href="../Styles/book.css"/>');
		expect(text).toContain('xml:lang="es" lang="es"');
		expect(new DOMParser().parseFromString(text, "application/xml").getElementsByTagName("parsererror").length).toBe(0);
		// Nav: before Tlön (the first entry of a later chapter), in its list.
		expect(navLabels(book)).toEqual(["Part One", "-Interlude & more", "-Tlön, Uqbar", "Unlinked"]);
		expect(book.text("OEBPS/nav.xhtml")).toContain('<a href="Text/chapter.xhtml">Interlude &amp; more</a>');
		expect(ncxLabels(book)).toEqual(["1:Part One", "2:Interlude & more", "3:Tlön"]);
		// A second one gets its own name and id.
		book.addChapter(-1, "Preface");
		expect(book.spine[0].path).toBe("OEBPS/Text/chapter-2.xhtml");
		expect(new Set(book.spine.map((s) => s.id)).size).toBe(4);
		expect(navLabels(book)[0]).toBe("Preface");
	});

	test("deleting a chapter lifts its sub-entries and removes its file", () => {
		const book = bothTocs();
		book.deleteChapter(0);
		expect(book.spine.map((s) => s.path)).toEqual(["OEBPS/Text/ch2.xhtml"]);
		expect(book.has("OEBPS/Text/ch 1.xhtml")).toBe(false);
		expect(book.text(book.opfPath)).not.toContain("ch%201.xhtml");
		expect(navLabels(book)).toEqual(["Tlön, Uqbar", "Unlinked"]);
		expect(ncxLabels(book)).toEqual(["1:Tlön"]);
		expect(() => book.deleteChapter(0)).toThrow("at least one chapter");
	});

	test("moving a chapter reorders the spine and the contents with it", () => {
		const book = bothTocs();
		book.addChapter(1, "Epilogue");
		expect(navLabels(book)).toEqual(["Part One", "-Tlön, Uqbar", "-Epilogue", "Unlinked"]);
		expect(book.moveChapter(2, 0)).toBe(true);
		expect(book.spine.map((s) => s.path)).toEqual(["OEBPS/Text/chapter.xhtml", "OEBPS/Text/ch 1.xhtml", "OEBPS/Text/ch2.xhtml"]);
		// Epilogue's list (Part One's children) is in spine order: it now leads.
		expect(navLabels(book)).toEqual(["Part One", "-Epilogue", "-Tlön, Uqbar", "Unlinked"]);
		// playOrder follows the reading order (Epilogue is now first in the spine).
		expect(ncxLabels(book)).toEqual(["2:Part One", "1:Epilogue", "3:Tlön"]);
	});

	test("renaming edits the first entry, or adds one", () => {
		const book = bothTocs();
		book.renameChapter(1, "Tlön (renamed)");
		expect(navLabels(book)).toEqual(["Part One", "-Tlön (renamed)", "Unlinked"]);
		expect(book.tocLabel("OEBPS/Text/ch2.xhtml")).toBe("Tlön (renamed)");
		expect(ncxLabels(book)).toEqual(["1:Part One", "2:Tlön (renamed)"]);
	});

	test("resources go in the book's image folder with a unique name", () => {
		const book = bothTocs();
		expect(book.imageDir()).toBe("OEBPS/Images");
		const path = book.addResource(book.imageDir(), "cover.jpg", new Uint8Array([1, 2, 3]));
		expect(path).toBe("OEBPS/Images/cover-2.jpg");
		expect(book.mediaType(path)).toBe("image/jpeg");
		expect(book.text(book.opfPath)).toContain('href="Images/cover-2.jpg" media-type="image/jpeg"');
		expect(unzipSync(book.toBytes())[path]).toEqual(new Uint8Array([1, 2, 3]));
	});

	test("a snapshot restores the book as it was", () => {
		const book = bothTocs();
		const before = book.snapshot();
		book.addChapter(0, "Gone");
		book.deleteChapter(0);
		book.restore(before);
		expect(book.spine.length).toBe(2);
		expect(navLabels(book)).toEqual(["Part One", "-Tlön, Uqbar", "Unlinked"]);
		expect(book.has("OEBPS/Text/ch 1.xhtml")).toBe(true);
	});

	test("search finds every occurrence in reading order", () => {
		const book = bothTocs();
		const hits = book.search("t");
		expect(hits.map((h) => `${h.index}.${h.occurrence}:${h.match}`)).toEqual(["0.0:t", "0.1:t", "1.0:T", "1.1:T", "1.2:t"]);
		expect(book.search("TLÖN", true)).toEqual([]);
		expect(book.search("more")[0]).toMatchObject({ index: 1, before: "Tlön Text & ", match: "more", after: "." });
		expect(book.search("  ")).toEqual([]);
	});
});

describe("obfuscated fonts", () => {
	const font = new Uint8Array(1200).map((_, i) => i % 251);
	const encryption = (algorithm: string) => `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
<enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="OEBPS/Fonts/a.ttf"/></enc:CipherData></enc:EncryptedData>
</encryption>`;
	const make = (algorithm: string, identifier: string, obfuscated: Uint8Array) =>
		EpubBook.read(
			epub({
				mimetype: "application/epub+zip",
				"META-INF/container.xml": CONTAINER,
				"META-INF/encryption.xml": encryption(algorithm),
				"OEBPS/content.opf": OPF3.replace("urn:uuid:1", identifier),
				"OEBPS/nav.xhtml": NAV,
				"OEBPS/Text/ch 1.xhtml": CH1,
				"OEBPS/Text/ch2.xhtml": CH2,
				"OEBPS/Fonts/a.ttf": obfuscated,
			}),
		);

	test("IDPF: the first 1040 bytes XORed with the SHA-1 of the identifier", async () => {
		const { createHash } = await import("node:crypto");
		const { deobfuscate } = await import("../src/renderer/epub/book");
		const key = new Uint8Array(createHash("sha1").update("urn:isbn:123", "utf8").digest());
		const book = make("http://www.idpf.org/2008/embedding", " urn:isbn:123 ", deobfuscate(font, key, 1040));
		expect(book.resource("OEBPS/Fonts/a.ttf")).toEqual(font);
		expect(book.bytes("OEBPS/Fonts/a.ttf")).not.toEqual(font);
	});

	test("Adobe: the first 1024 bytes XORed with the identifier's UUID", async () => {
		const { deobfuscate } = await import("../src/renderer/epub/book");
		const uuid = "12345678-9abc-def0-1234-56789abcdef0";
		const key = new Uint8Array(uuid.replace(/-/g, "").match(/../g)!.map((b) => Number.parseInt(b, 16)));
		const book = make("http://ns.adobe.com/pdf/enc#RC", `urn:uuid:${uuid}`, deobfuscate(font, key, 1024));
		expect(book.resource("OEBPS/Fonts/a.ttf")).toEqual(font);
	});
});

describe("sections", () => {
	// Spine: ch 1, ch 1b, ch2, ch2b; the contents list ch 1 and ch2 only.
	const split = () =>
		EpubBook.read(
			epub({
				mimetype: "application/epub+zip",
				"META-INF/container.xml": CONTAINER,
				"OEBPS/content.opf": OPF3.replace(
					'<item id="c2"',
					'<item id="c1b" href="Text/ch1b.xhtml" media-type="application/xhtml+xml"/><item id="c2b" href="Text/ch2b.xhtml" media-type="application/xhtml+xml"/><item id="c2"',
				).replace('<spine><itemref idref="c1"/><itemref idref="c2"/></spine>', '<spine><itemref idref="c1"/><itemref idref="c1b"/><itemref idref="c2"/><itemref idref="c2b"/></spine>'),
				"OEBPS/nav.xhtml": NAV.replace('<li><a href="Text/ch%201.xhtml">Part One</a>\n    <ol><li><a href="Text/ch2.xhtml#tlon">Tlön, Uqbar</a></li></ol></li>', '<li><a href="Text/ch%201.xhtml">Part One</a></li><li><a href="Text/ch2.xhtml">Two</a></li>'),
				"OEBPS/Text/ch 1.xhtml": CH1,
				"OEBPS/Text/ch1b.xhtml": CH2.replace("Tlön", "One b"),
				"OEBPS/Text/ch2.xhtml": CH2,
				"OEBPS/Text/ch2b.xhtml": CH2.replace("Tlön", "Two b"),
			}),
		);
	const names = (book: InstanceType<typeof EpubBook>) => book.spine.map((s) => s.path.replace("OEBPS/Text/", ""));

	test("a section runs from its entry to the next entry", () => {
		const book = split();
		expect([0, 1, 2, 3].map((i) => book.sectionOf(i))).toEqual([
			{ start: 0, end: 1 },
			{ start: 0, end: 1 },
			{ start: 2, end: 3 },
			{ start: 2, end: 3 },
		]);
	});

	test("a new chapter goes after the whole section", () => {
		const book = split();
		book.addChapter(book.sectionOf(0).end, "Between");
		expect(names(book)).toEqual(["ch 1.xhtml", "ch1b.xhtml", "chapter.xhtml", "ch2.xhtml", "ch2b.xhtml"]);
		expect(navLabels(book)).toEqual(["Part One", "Between", "Two", "Unlinked"]);
	});

	test("sections move as a whole, with their entries", () => {
		const book = split();
		expect(book.moveSection(2, -1)).toBe(0);
		expect(names(book)).toEqual(["ch2.xhtml", "ch2b.xhtml", "ch 1.xhtml", "ch1b.xhtml"]);
		expect(navLabels(book)).toEqual(["Two", "Part One", "Unlinked"]);
		expect(book.moveSection(0, 1)).toBe(2);
		expect(names(book)).toEqual(["ch 1.xhtml", "ch1b.xhtml", "ch2.xhtml", "ch2b.xhtml"]);
		expect(book.moveSection(0, -1)).toBe(-1);
	});

	test("deleting a section removes all its files", () => {
		const book = split();
		book.deleteSection(3);
		expect(names(book)).toEqual(["ch 1.xhtml", "ch1b.xhtml"]);
		expect(book.has("OEBPS/Text/ch2b.xhtml")).toBe(false);
		expect(() => book.deleteSection(0)).toThrow("at least one chapter");
	});
});

describe("text index", () => {
	test("blocks are spaced, whitespace folded, and matches map back to ranges", async () => {
		const { textIndex, occurrences, rangeAt } = await import("../src/renderer/epub/text-index");
		const doc = new JSDOM("<!doctype html><body><h1>Tlön</h1><p>A  <b>lab</b>yrinth,\n a labyrinth</p><script>x</script></body>").window.document;
		const index = textIndex(doc.body);
		expect(index.text).toBe("Tlön A labyrinth, a labyrinth");
		const found = occurrences(index.text, "LABYRINTH", false);
		expect(found).toEqual([7, 20]);
		const first = rangeAt(index, found[0], 9, doc);
		expect(first?.toString()).toBe("labyrinth");
		expect(first?.startContainer.parentElement?.localName).toBe("b");
		// A match across the block boundary still begins and ends on text.
		expect(rangeAt(index, 0, 6, doc)?.toString()).toBe("TlönA");
	});
});

describe("contents nesting", () => {
	test("indenting puts an entry under the one before; outdenting takes it back with the reading order kept", () => {
		const book = bothTocs();
		book.addChapter(1, "Three");
		book.addChapter(2, "Four");
		expect(navLabels(book)).toEqual(["Part One", "-Tlön, Uqbar", "-Three", "-Four", "Unlinked"]);
		// Three goes under Tlön.
		expect(book.nestChapter(2, 1)).toBe(true);
		expect(navLabels(book)).toEqual(["Part One", "-Tlön, Uqbar", "--Three", "-Four", "Unlinked"]);
		expect(ncxLabels(book)).toEqual(["1:Part One", "2:Tlön", "3:Three", "4:Four"]);
		expect(book.tocDepth(book.spine[2].path)).toBe(2);
		// Tlön comes up a level: Three and Four (after it) become its children.
		expect(book.nestChapter(1, -1)).toBe(true);
		expect(navLabels(book)).toEqual(["Part One", "Tlön, Uqbar", "-Three", "-Four", "Unlinked"]);
		expect(ncxLabels(book)).toEqual(["1:Part One", "2:Tlön", "3:Three", "4:Four"]);
		const nav = book.text("OEBPS/nav.xhtml");
		expect(new DOMParser().parseFromString(nav, "application/xml").getElementsByTagName("parsererror").length).toBe(0);
		// Part One's emptied list went.
		expect(nav).not.toMatch(/<ol>\s*<\/ol>/);
		// The first entry has nothing before it to go under, nor a level above.
		expect(book.nestChapter(0, 1)).toBe(false);
		expect(book.nestChapter(0, -1)).toBe(false);
	});
});

describe("landmarks", () => {
	test("EPUB 3: the landmarks nav is made, entries replace their kind, and go", () => {
		const book = book3();
		expect(book.landmarks()).toEqual([]);
		book.setLandmark("bodymatter", 1);
		book.setLandmark("cover", 0);
		book.setLandmark("bodymatter", 0);
		expect(book.landmarks().map((l) => [l.type, l.path])).toEqual([
			["cover", "OEBPS/Text/ch 1.xhtml"],
			["bodymatter", "OEBPS/Text/ch 1.xhtml"],
		]);
		const nav = book.text("OEBPS/nav.xhtml");
		// The book's own landmarks nav is used (its untyped link is no landmark).
		expect(nav.match(/<nav epub:type="landmarks"/g)?.length).toBe(1);
		expect(nav).toContain('<a epub:type="bodymatter" href="Text/ch%201.xhtml">Start of text</a>');
		expect(new DOMParser().parseFromString(nav, "application/xml").getElementsByTagName("parsererror").length).toBe(0);
		// The contents are still the toc nav's.
		expect(navLabels(book)).toEqual(["Part One", "-Tlön, Uqbar", "Unlinked"]);
		// No guide is made in EPUB 3.
		expect(book.text(book.opfPath)).not.toContain("<guide");
		book.setLandmark("cover", null);
		expect(book.landmarks().map((l) => l.type)).toEqual(["bodymatter"]);
	});

	test("EPUB 2: the guide is made after the spine and kept", () => {
		const opf2 = OPF3.replace('version="3.0"', 'version="2.0"').replace(' properties="nav"', "").replace("<spine>", '<spine toc="ncx">').replace("<manifest>", '<manifest>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
		const book = EpubBook.read(
			epub({ mimetype: "application/epub+zip", "META-INF/container.xml": CONTAINER, "OEBPS/content.opf": opf2, "OEBPS/toc.ncx": NCX, "OEBPS/nav.xhtml": NAV, "OEBPS/Text/ch 1.xhtml": CH1, "OEBPS/Text/ch2.xhtml": CH2 }),
		);
		book.setLandmark("bodymatter", 1);
		const opf = book.text(book.opfPath);
		expect(opf).toMatch(/<\/spine>\s*<guide><reference type="text" title="Start of text" href="Text\/ch2.xhtml"\/><\/guide>/);
		expect(book.landmarks()).toEqual([{ type: "bodymatter", label: "Start of text", path: "OEBPS/Text/ch2.xhtml", fragment: "" }]);
		book.setLandmark("bodymatter", 0);
		expect(book.text(book.opfPath).match(/<reference/g)?.length).toBe(1);
		expect(book.spine.length).toBe(2);
	});
});

test("a book without a landmarks nav gets a hidden one", () => {
	const book = EpubBook.read(
		epub({
			mimetype: "application/epub+zip",
			"META-INF/container.xml": CONTAINER,
			"OEBPS/content.opf": OPF3,
			"OEBPS/nav.xhtml": NAV.replace(/<nav epub:type="landmarks">[\s\S]*?<\/nav>/, ""),
			"OEBPS/Text/ch 1.xhtml": CH1,
			"OEBPS/Text/ch2.xhtml": CH2,
		}),
	);
	book.setLandmark("toc", 0);
	const nav = book.text("OEBPS/nav.xhtml");
	expect(nav).toContain('<nav epub:type="landmarks" hidden="hidden"><h2>Landmarks</h2><ol><li><a epub:type="toc" href="Text/ch%201.xhtml">Contents</a></li></ol></nav>');
	expect(book.landmarks().map((l) => l.type)).toEqual(["toc"]);
});

describe("review fixes", () => {
	// Contents A > A1, then B (each its own file).
	const nested = () => {
		const book = bothTocs();
		book.addChapter(1, "B");
		return book;
	};

	test("moving a chapter up past a sibling with sub-entries moves whole blocks", () => {
		const book = nested();
		expect(navLabels(book)).toEqual(["Part One", "-Tlön, Uqbar", "-B", "Unlinked"]);
		// B moves up past Tlön (its sibling inside Part One), not into it.
		expect(book.moveSection(2, -1)).toBe(1);
		expect(navLabels(book)).toEqual(["Part One", "-B", "-Tlön, Uqbar", "Unlinked"]);
		expect(book.spine.map((s) => s.path.replace("OEBPS/Text/", ""))).toEqual(["ch 1.xhtml", "chapter.xhtml", "ch2.xhtml"]);
		expect(ncxLabels(book)).toEqual(["1:Part One", "2:B", "3:Tlön"]);
		// Part One has no sibling before it.
		expect(book.moveSection(0, -1)).toBe(-1);
	});

	test("a top-level chapter moves with its sub-entries' files", () => {
		const book = bothTocs();
		// Contents: Part One (ch 1) > Tlön (ch2); then C after everything.
		const c = book.addChapter(1, "C");
		book.nestChapter(c, -1);
		expect(navLabels(book)).toEqual(["Part One", "-Tlön, Uqbar", "C", "Unlinked"]);
		expect(book.moveSection(c, -1)).toBe(0);
		expect(book.spine.map((s) => s.path.replace("OEBPS/Text/", ""))).toEqual(["chapter.xhtml", "ch 1.xhtml", "ch2.xhtml"]);
		expect(navLabels(book)).toEqual(["C", "Part One", "-Tlön, Uqbar", "Unlinked"]);
	});

	test("deleting a chapter removes the landmarks that named it", () => {
		const book = book3();
		book.setLandmark("bodymatter", 1);
		book.setLandmark("cover", 0);
		book.deleteChapter(1);
		expect(book.landmarks().map((l) => l.type)).toEqual(["cover"]);
		expect(book.text("OEBPS/nav.xhtml")).not.toContain("bodymatter");
	});

	test("playOrder numbers page targets with the nav points, in reading order", () => {
		const withPages = NCX.replace("</navMap>", '</navMap><pageList><pageTarget id="pg1" type="normal" value="1" playOrder="9"><navLabel><text>1</text></navLabel><content src="Text/ch2.xhtml"/></pageTarget></pageList>');
		const book = EpubBook.read(
			epub({
				mimetype: "application/epub+zip",
				"META-INF/container.xml": CONTAINER,
				"OEBPS/content.opf": OPF3.replace("<spine>", '<spine toc="ncx">').replace("<manifest>", '<manifest>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'),
				"OEBPS/nav.xhtml": NAV,
				"OEBPS/toc.ncx": withPages,
				"OEBPS/Text/ch 1.xhtml": CH1,
				"OEBPS/Text/ch2.xhtml": CH2,
			}),
		);
		book.renameChapter(0, "Renamed");
		const doc = new DOMParser().parseFromString(book.text("OEBPS/toc.ncx"), "application/xml");
		const orders = Array.from(doc.getElementsByTagName("*"))
			.filter((e) => e.localName === "navPoint" || e.localName === "pageTarget")
			.map((e) => `${e.localName}:${e.getAttribute("playOrder")}`);
		// ch 1 first; Tlön (ch2#tlon) and page 1 (ch2) are later, distinct targets.
		expect(orders).toEqual(["navPoint:1", "navPoint:2", "pageTarget:3"]);
	});
});
