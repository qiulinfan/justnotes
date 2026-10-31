import { describe, expect, test } from "bun:test";
import { MarkdownPreviewRenderer, renderMarkdownSections } from "../src/api/markdown";

const exists = (path: string) => path !== "Missing";
const render = (markdown: string, options = {}) => renderMarkdownSections(markdown, { docId: "D", resolve: exists, ...options });
const html = (markdown: string, options = {}) =>
	render(markdown, options)
		.sections.map((s) => s.html)
		.join("");

// The attributes of every <tag> in `source`, in order, so assertions do not
// depend on attribute order.
function tags(source: string, tag: string) {
	return [...source.matchAll(new RegExp(`<${tag}((?:\\s+[\\w-]+(?:="[^"]*")?)*)\\s*>`, "g"))].map((m) =>
		Object.fromEntries([...m[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? ""])),
	);
}

// Plugins and themes select a.internal-link[data-href]; the click handler and
// page preview read data-href, and CSS greys out is-unresolved targets.
describe("internal links", () => {
	test("a wikilink carries Obsidian's attributes and shows path > heading", () => {
		const out = html("[[Note#Part]]");
		expect(tags(out, "a")[0]).toEqual({ "data-href": "Note#Part", href: "Note#Part", class: "internal-link", target: "_blank", rel: "noopener nofollow" });
		expect(out).toContain(">Note &gt; Part</a>");
	});

	test("an alias shows its text and keeps the target in aria-label", () => {
		const out = html("[[Note|Shown]]");
		expect(tags(out, "a")[0]["aria-label"]).toBe("Note");
		expect(out).toContain(">Shown</a>");
	});

	test("a link to a missing note is unresolved", () => {
		expect(tags(html("[[Missing]]"), "a")[0].class).toBe("internal-link is-unresolved");
	});

	test("a Markdown link to a vault file is internal, with the decoded path", () => {
		const a = tags(html("[x](My%20Note.md)"), "a")[0];
		expect(a.class).toBe("internal-link");
		expect(a["data-href"]).toBe("My Note.md");
	});

	test("a URL is an external link that opens outside the window", () => {
		expect(tags(html("[x](https://a.b) and https://c.d"), "a")).toEqual([
			{ href: "https://a.b", class: "external-link", target: "_blank", rel: "noopener nofollow" },
			{ href: "https://c.d", class: "external-link", target: "_blank", rel: "noopener nofollow" },
		]);
	});

	test("a file name is not linkified as a domain", () => {
		expect(html("see notes.md")).not.toContain("<a");
	});
});

// getSectionInfo hands plugins these ranges to rewrite the source; an offset
// edits the wrong lines.
describe("sections", () => {
	test("line ranges count from the top of the file, frontmatter included", () => {
		const { sections } = render("---\na: 1\n---\n# H\n\n- x\n- y\n\n\npara");
		expect(sections.map((s) => [s.lineStart, s.lineEnd])).toEqual([
			[0, 2],
			[3, 3],
			[5, 6],
			[9, 9],
		]);
	});

	test("the frontmatter is parsed and rendered hidden", () => {
		const { sections, frontmatter } = render("---\ntitle: T\n---\ntext");
		expect(frontmatter).toEqual({ title: "T" });
		expect(tags(sections[0].html, "pre")[0]).toMatchObject({ class: "frontmatter language-yaml", style: "display: none;" });
	});

	test("text without frontmatter has none", () => {
		expect(render("text").frontmatter).toBeNull();
	});
});

// Callout CSS and the fold toggle key on these classes and attributes.
describe("callouts", () => {
	test("a folded callout starts collapsed with its metadata and title", () => {
		const out = html("> [!Warning|wide]- Careful\n> body");
		const [callout, title, , , fold, content] = tags(out, "div");
		expect(callout).toEqual({ "data-callout-metadata": "wide", "data-callout-fold": "-", "data-callout": "warning", class: "callout is-collapsible is-collapsed" });
		expect(title.class).toBe("callout-title");
		expect(out).toContain('<div class="callout-title-inner">Careful</div>');
		expect(fold.class).toBe("callout-fold is-collapsed");
		expect(content).toEqual({ class: "callout-content", style: "display: none;" });
		expect(out).toContain(">body</p>");
	});

	test("without a title the type names the callout", () => {
		expect(html("> [!tip]\n> body")).toContain('<div class="callout-title-inner">Tip</div>');
	});
});

// Tasks: the checkbox handler maps data-line (relative to the section) back
// to the file line it toggles.
describe("task lists", () => {
	test("items carry their status and section-relative line", () => {
		const { sections } = render("intro\n\n- [ ] open\n- [/] doing");
		const list = sections[1].html;
		expect(tags(list, "ul")[0].class).toBe("contains-task-list");
		expect(tags(list, "li")).toEqual([
			{ "data-line": "0", "data-task": " ", class: "task-list-item", dir: "auto" },
			{ "data-line": "1", "data-task": "/", class: "task-list-item is-checked", dir: "auto" },
		]);
		expect(tags(list, "input")).toEqual([
			{ "data-line": "0", class: "task-list-item-checkbox", type: "checkbox" },
			{ "data-line": "1", class: "task-list-item-checkbox", type: "checkbox", checked: "" },
		]);
		expect(list).not.toContain("[/]");
	});
});

describe("math", () => {
	// Prices must not turn a sentence into a formula.
	test("dollar amounts stay text", () => {
		expect(html("price $5 and $6 total")).not.toContain("math");
	});

	test("inline and inline-display math become placeholders", () => {
		expect(tags(html("$x^2$ and $$y$$"), "span")).toEqual([
			{ class: "math math-inline", "data-tex": "x^2" },
			{ class: "math math-block", "data-tex": "y" },
		]);
	});

	test("a $$ block may follow a paragraph line directly", () => {
		const { sections } = render("text\n$$\na\n$$");
		expect(sections.map((s) => [s.lineStart, s.lineEnd])).toEqual([
			[0, 0],
			[1, 3],
		]);
		expect(tags(sections[1].html, "div")[0]).toEqual({ class: "math math-block", "data-tex": "a" });
	});
});

// Comments and block ids are notes to self; reading view never shows them.
describe("hidden syntax", () => {
	test("comments vanish inline and across lines, but not in code", () => {
		const out = html("a %%x%% b\n\nc %%start\n\nhidden\nend%% d\n\n`%%kept%%`");
		expect(out).not.toMatch(/x|start|hidden|end/);
		expect(out).toContain("<code>%%kept%%</code>");
	});

	// A Jupyter or shell %% line in a fence inside a callout or list item once
	// opened a comment that hid the code and everything after it.
	test("fences in callouts and list items keep their %%", () => {
		const out = html("> [!note]\n> ```bash\n> %%bash\n> ```\n\n- item\n\t```py\n\t%%timeit\n\t```\n- ```m\n  %% cell\n  ```\n\n```a``` %%gone%%\n\nafter %%gone%% text");
		expect(out).toContain('<code class="language-bash is-loaded">%%bash</code>');
		expect(out).toContain('<code class="language-py is-loaded">%%timeit</code>');
		expect(out).toContain('<code class="language-m is-loaded">%% cell</code>');
		expect(out).not.toContain("gone");
		expect(out).toContain("after  text");
	});

	// Obsidian keeps %% in a $$ block (TeX reads it as its own comment) and in
	// indented code; the reading view once blanked it there.
	test("math blocks and indented code keep their %%, a list item's paragraph does not", () => {
		const out = html("$$\na %% b\n$$\n\n> $$\n> c %% d\n> $$\n\ntext\n\n    code %% kept\n\n- item\n\n    para %%gone%% x\n\nafter %%gone%% y");
		expect(tags(out, "div").map((d) => d["data-tex"])).toEqual(["a %% b", "c %% d"]);
		expect(out).toContain("<code>code %% kept</code>");
		expect(out).toContain("para  x");
		expect(out).toContain("after  y");
	});

	test("an unclosed comment hides the rest of the note", () => {
		expect(html("shown\n\n%% open\n\n# gone")).not.toContain("gone");
	});

	test("block ids are hidden, and a line holding only one disappears", () => {
		const { sections } = render("para ^abc\n\n^def");
		expect(sections.map((s) => s.html)).toEqual(['<p dir="auto">para</p>\n']);
	});

	test("an id on the line under a paragraph is that paragraph's, and hidden", () => {
		expect(html("Para line one\n^lone")).toBe('<p dir="auto">Para line one</p>\n');
	});
});

describe("inline syntax", () => {
	test("highlight and strikethrough render as mark and del", () => {
		expect(html("==hi== ~~no~~")).toContain("<mark>hi</mark> <del>no</del>");
	});

	test("tags link to search; mid-word and numeric ones do not", () => {
		const out = html("#a/b c#d #12");
		expect(tags(out, "a")).toEqual([{ href: "#a/b", class: "tag", target: "_blank", rel: "noopener nofollow" }]);
		expect(out).toContain("c#d #12");
	});

	test("headings carry their plain text for anchors", () => {
		expect(tags(html("## A **b** `c`"), "h2")[0]["data-heading"]).toBe("A b c");
	});

	test("soft breaks are <br> unless strict line breaks are on", () => {
		expect(html("a\nb")).toContain("<br>");
		expect(html("a\nb", { strictLineBreaks: true })).not.toContain("<br>");
	});
});

// Footnote links scroll to these ids; they must be unique per rendered note.
describe("footnotes", () => {
	test("references are numbered in order and listed at the end", () => {
		const out = html("x[^b] y^[inline]\n\n[^b]: Bee.");
		expect(tags(out, "sup").map((s) => s.id)).toEqual(["fnref-1-D", "fnref-2-D"]);
		expect(tags(out, "li").map((l) => l.id)).toEqual(["fn-1-D", "fn-2-D"]);
		expect(out).toMatch(/Bee\. <a href="#fnref-1-D"/);
		expect(out).toMatch(/inline <a href="#fnref-2-D"/);
	});

	test("a reference without a definition stays text", () => {
		expect(html("x[^none]")).toContain("x[^none]");
	});
});

// Embeds are resolved after sanitizing; the placeholder must carry the target
// and the size the user asked for.
describe("embeds", () => {
	test("![[file|WxH]] sizes the embed", () => {
		expect(tags(html("![[pic.png|200x100]]"), "span")[0]).toMatchObject({ src: "pic.png", width: "200", height: "100", alt: "pic.png", class: "internal-embed" });
	});

	test("a local Markdown image embeds like a wikilink; a remote one stays an img", () => {
		const out = html("![cap|50](sub/pic%201.png) ![r](https://x/y.png)");
		expect(tags(out, "span")[0]).toMatchObject({ src: "sub/pic 1.png", width: "50", alt: "cap", class: "internal-embed" });
		expect(tags(out, "img")).toEqual([{ src: "https://x/y.png", alt: "r" }]);
	});
});

// Prism highlights on the page by the language class; the copy button reads
// the code's text.
describe("code blocks", () => {
	test("a fence carries its language, escaped text and a copy button", () => {
		const out = html("```js\n<b>\n```");
		expect(tags(out, "pre")[0]).toEqual({ class: "language-js", tabindex: "0" });
		expect(tags(out, "code")[0].class).toBe("language-js is-loaded");
		expect(out).toContain(">&lt;b&gt;</code>");
		expect(out).toContain('<button class="copy-code-button">Copy</button>');
	});
});

// Live Preview renders a fence as a widget when its language has a handler;
// unloading one plugin must not drop another plugin's handler.
describe("code-block processor registry", () => {
	test("unregistering the latest handler restores the previous one", () => {
		const first = () => {};
		const second = () => {};
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor("test-lang", first);
		MarkdownPreviewRenderer.registerCodeBlockPostProcessor("test-lang", second);
		expect(MarkdownPreviewRenderer.codeBlockPostProcessors["test-lang"]).toBe(second);
		MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor("test-lang", second);
		expect(MarkdownPreviewRenderer.codeBlockPostProcessors["test-lang"]).toBe(first);
		MarkdownPreviewRenderer.unregisterCodeBlockPostProcessor("test-lang", first);
		expect("test-lang" in MarkdownPreviewRenderer.codeBlockPostProcessors).toBe(false);
	});
});

// Typora writes paths with bare spaces; CommonMark (and markdown-it) leave
// them as text, so 137 images in the owner's vaults showed as source.
describe("paths with bare spaces", () => {
	test("an image or note link whose path has spaces renders; prose in parentheses and titled links do not change", () => {
		const out = html("![Shot](a.assets/Screenshot 2025-02-09 at 15.04.04.png) [My Note](My Note.md#Part one) (see the note) ![t](a.png \"title\")");
		const spans = tags(out, "span").filter((t) => t.class === "internal-embed");
		expect(spans.map((t) => t.src)).toEqual(["a.assets/Screenshot 2025-02-09 at 15.04.04.png", "a.png"]);
		expect(tags(out, "a")[0]).toMatchObject({ "data-href": "My Note.md#Part one" });
		expect(out).toContain("(see the note)");
	});
});

