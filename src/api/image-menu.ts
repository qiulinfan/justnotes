import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App } from "./app";
import { relativeSrc } from "./attachments";
import { resolveHtmlSrc } from "./markdown";
import { getLinkpath } from "./metadata-utils";
import { attempt, MoveModal, PromptModal } from "./ui/file-modals";
import { Menu } from "./ui/menu";
import type { TFile } from "./vault";

// Double-clicking an image in a note opens the image menu: zoom presets that
// rewrite the image's size in the source (an HTML <img>'s `zoom` style, as
// Typora writes it, or a wikilink or Markdown embed's width from the image's
// natural width), alignment (an <img> style; an embed becomes an <img>
// first) and renaming or moving the image file, whose links follow.

export const ZOOM_PRESETS = [100, 75, 67, 50, 33, 25];

export type ImageKind = "html" | "wikilink" | "markdown";

export interface ImageRef {
	kind: ImageKind;
	from: number;
	to: number;
	// The src or link target as written.
	target: string;
}

const IMAGE_SOURCES = /<img\b[^>]*>|!\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/gi;
const HTML_SRC = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

// The images written in `text`, in order: <img> tags, `![[...]]` embeds and
// `![...](...)` images, leaving out those in inline code.
export function findImageRefs(text: string): ImageRef[] {
	const masked = text.replace(/(`+)[^`]*?\1/g, (code) => " ".repeat(code.length));
	const refs: ImageRef[] = [];
	for (const m of masked.matchAll(IMAGE_SOURCES)) {
		const from = m.index;
		const to = from + m[0].length;
		if (m[0].startsWith("<")) {
			const src = HTML_SRC.exec(m[0]);
			refs.push({ kind: "html", from, to, target: src ? (src[1] ?? src[2] ?? src[3]) : "" });
		} else if (m[1] !== undefined) {
			refs.push({ kind: "wikilink", from, to, target: m[1].split("|")[0].trim() });
		} else {
			refs.push({ kind: "markdown", from, to, target: m[3].replace(/^<|>$/g, "") });
		}
	}
	return refs;
}

// A trailing `|300` or `|300x200` (or the whole text) of an embed's alias or
// alt text: the size, as both views read it.
const SIZE = /(?:^|\|)\s*(\d+)(?:x(\d+))?\s*$/;

function splitSize(alt: string) {
	const m = SIZE.exec(alt);
	return m ? { rest: alt.slice(0, m.index), width: Number(m[1]) } : { rest: alt, width: null };
}

// A Markdown image's width always follows a bar (`![|300](x.png)`): the
// reading view reads a bare number as the size only for a vault file.
function withWidth(alt: string, width: number | null, bare: boolean) {
	const { rest } = splitSize(alt);
	if (width === null) return rest;
	return rest || !bare ? `${rest}|${width}` : String(width);
}

// An <img> tag with its zoom set to `zoom`% (null removes it), every other
// attribute and style declaration kept as written.
export function setHtmlZoom(tag: string, zoom: number | null): string {
	const style = /(\sstyle\s*=\s*)(?:(["'])(.*?)\2|([^\s"'>]+))/i.exec(tag);
	if (!style) {
		if (zoom === null) return tag;
		const end = /\s*(\/?)>$/.exec(tag);
		if (!end) return tag;
		return `${tag.slice(0, end.index)} style="zoom:${zoom}%;"${end[1] ? " />" : ">"}`;
	}
	const css = style[3] ?? style[4] ?? "";
	const quote = style[2] ?? '"';
	let next: string;
	if (/(^|;)\s*zoom\s*:/i.test(css)) {
		next = zoom === null ? css.replace(/(^|;)\s*zoom\s*:[^;]*;?/i, "$1").trim() : css.replace(/((?:^|;)\s*zoom\s*:\s*)[^;]*/i, `$1${zoom}%`);
	} else {
		if (zoom === null) return tag;
		next = `zoom:${zoom}%;${css.trim() ? ` ${css.trim()}` : ""}`;
	}
	const at = style.index;
	const end = at + style[0].length;
	if (!next.replace(/;/g, "").trim()) return tag.slice(0, at) + tag.slice(end);
	return `${tag.slice(0, at)}${style[1]}${quote}${next}${quote}${tag.slice(end)}`;
}

// The source of an image (`text` is the whole ref) zoomed to `zoom`% or,
// null, reset: an <img>'s zoom style, an embed's width as that share of
// `naturalWidth`.
export function zoomImageSource(text: string, kind: ImageKind, zoom: number | null, naturalWidth: number): string {
	if (kind === "html") return setHtmlZoom(text, zoom);
	const width = zoom === null || !naturalWidth ? null : Math.max(1, Math.round((naturalWidth * zoom) / 100));
	if (zoom !== null && width === null) return text;
	if (kind === "wikilink") {
		const inner = text.slice(3, -2);
		const bar = inner.indexOf("|");
		const target = bar < 0 ? inner : inner.slice(0, bar);
		const alias = withWidth(bar < 0 ? "" : inner.slice(bar + 1), width, true);
		return `![[${target}${alias ? `|${alias}` : ""}]]`;
	}
	const close = text.indexOf("](");
	return `![${withWidth(text.slice(2, close), width, false)}${text.slice(close)}`;
}

// The zoom in % the source shows now, for the menu's check; null when none
// is set.
export function currentZoom(text: string, kind: ImageKind, naturalWidth: number): number | null {
	if (kind === "html") {
		const m = /zoom\s*:\s*([\d.]+)%/i.exec(text);
		return m ? Number(m[1]) : null;
	}
	const alt = kind === "wikilink" ? text.slice(3, -2).split("|").slice(1).join("|") : text.slice(2, text.indexOf("]("));
	const { width } = splitSize(alt);
	return width === null || !naturalWidth ? null : Math.round((width / naturalWidth) * 100);
}

export type ImageAlign = "left" | "center" | "right";

// Alignment as a style both views and Obsidian render the same way: a block
// image with auto margins on the side(s) it moves away from.
const ALIGN_MARGIN: Record<ImageAlign, string> = { left: "0 auto 0 0", center: "0 auto", right: "0 0 0 auto" };
const ALIGN_PROPS = /^(display|margin|margin-left|margin-right)\s*:/i;
const STYLE_ATTR = /(\sstyle\s*=\s*)(?:(["'])(.*?)\2|([^\s"'>]+))/i;

// An <img> tag aligned (null removes the alignment): its display and margin
// declarations are replaced, the others and every attribute kept.
export function setHtmlAlign(tag: string, align: ImageAlign | null): string {
	const style = STYLE_ATTR.exec(tag);
	const decls = (style ? (style[3] ?? style[4] ?? "") : "")
		.split(";")
		.map((d) => d.trim())
		.filter(Boolean);
	const kept = decls.filter((d) => !ALIGN_PROPS.test(d));
	if (align) kept.push("display:block", `margin:${ALIGN_MARGIN[align]}`);
	if (kept.length === decls.length && kept.every((d, i) => d === decls[i])) return tag;
	const css = kept.length ? `${kept.join("; ")};` : "";
	if (style) {
		const at = style.index;
		const end = at + style[0].length;
		const quote = style[2] ?? '"';
		return css ? `${tag.slice(0, at)}${style[1]}${quote}${css}${quote}${tag.slice(end)}` : tag.slice(0, at) + tag.slice(end);
	}
	const end = /\s*(\/?)>$/.exec(tag);
	return end ? `${tag.slice(0, end.index)} style="${css}"${end[1] ? " />" : ">"}` : tag;
}

// The alignment an <img> tag's style shows; null for none (and for embeds).
export function currentAlign(text: string, kind: ImageKind): ImageAlign | null {
	if (kind !== "html") return null;
	const margin = /(?:^|[\s;"'])margin\s*:\s*([^;"']*)/i.exec(STYLE_ATTR.exec(text)?.[0] ?? "")?.[1]?.trim();
	return (Object.keys(ALIGN_MARGIN) as ImageAlign[]).find((a) => ALIGN_MARGIN[a] === margin) ?? null;
}

// A wikilink or Markdown image as an <img> tag (its size as width and
// height attributes, its alt text or else `name` as alt), so it can carry an
// alignment: embeds have no Obsidian syntax for one.
export function embedAsHtml(text: string, kind: Exclude<ImageKind, "html">, src: string, name: string): string {
	const alt = kind === "wikilink" ? text.slice(3, -2).split("|").slice(1).join("|") : text.slice(2, text.indexOf("]("));
	const m = SIZE.exec(alt);
	const rest = (m ? alt.slice(0, m.index) : alt).trim();
	const size = m ? ` width="${m[1]}"${m[2] ? ` height="${m[2]}"` : ""}` : "";
	return `<img src="${src.replace(/"/g, "%22")}" alt="${(rest || name).replace(/"/g, "&quot;")}"${size} />`;
}

// The vault file an image ref shows, as the views resolve it; null for a URL
// or a missing file.
export function imageFile(app: App, ref: ImageRef, sourcePath: string): TFile | null {
	const dest = (path: string) => app.metadataCache.getFirstLinkpathDest(path, sourcePath);
	if (ref.kind === "html") return resolveHtmlSrc(ref.target, dest);
	let target = ref.target;
	try {
		target = decodeURI(target);
	} catch {}
	return /^[a-z][\w+.-]*:/i.test(target) ? null : dest(getLinkpath(target));
}

// Where the image menu acts: the note's app and path, and how to save the
// note before a file operation reads its links.
export interface ImageMenuHost {
	app: App;
	sourcePath(): string;
	save?(): Promise<void>;
}

// The image menu for `ref` (positions in `view`'s document). A size or
// alignment pick rewrites the ref as one undoable change, then `changed`
// runs; rename and move go through fileManager.renameFile, so links (and
// <img> srcs) follow.
export function openImageMenu(evt: MouseEvent, host: ImageMenuHost, view: EditorView, ref: ImageRef, img: HTMLImageElement, changed?: () => void) {
	const text = view.state.sliceDoc(ref.from, ref.to);
	const sourcePath = host.sourcePath();
	const file = imageFile(host.app, ref, sourcePath);
	const rewrite = (next: (text: string) => string) => {
		// The note may have changed while the menu was open.
		if (view.state.sliceDoc(ref.from, ref.to) !== text) return;
		const insert = next(text);
		if (insert === text) return;
		view.dispatch({ changes: { from: ref.from, to: ref.to, insert } });
		changed?.();
	};
	const zoom = currentZoom(text, ref.kind, img.naturalWidth);
	const aligned = currentAlign(text, ref.kind);
	const menu = new Menu();
	for (const preset of ZOOM_PRESETS) {
		menu.addItem((item) =>
			item
				.setTitle(`${preset}%`)
				.setChecked(zoom === preset)
				.onClick(() => rewrite((t) => zoomImageSource(t, ref.kind, preset, img.naturalWidth))),
		);
	}
	menu.addItem((item) =>
		item
			.setTitle("Reset size")
			.setIcon("rotate-ccw")
			.onClick(() => rewrite((t) => zoomImageSource(t, ref.kind, null, img.naturalWidth))),
	);
	menu.addSeparator();
	const icons: Record<ImageAlign, string> = { left: "align-left", center: "align-center", right: "align-right" };
	for (const align of ["left", "center", "right"] as ImageAlign[]) {
		menu.addItem((item) =>
			item
				.setTitle(`Align ${align}`)
				.setIcon(icons[align])
				.setChecked(aligned === align)
				.onClick(() =>
					rewrite((t) => {
						if (ref.kind === "html") return setHtmlAlign(t, align);
						const src = file ? relativeSrc(sourcePath, file.path) : ref.target;
						return setHtmlAlign(embedAsHtml(t, ref.kind, src, file?.basename ?? ""), align);
					}),
				),
		);
	}
	menu.addItem((item) =>
		item
			.setTitle("Reset alignment")
			.setIcon("rotate-ccw")
			.setDisabled(!aligned)
			.onClick(() => rewrite((t) => setHtmlAlign(t, null))),
	);
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle("Rename image...")
			.setIcon("pencil")
			.setDisabled(!file)
			.onClick(async () => {
				if (!file) return;
				await host.save?.();
				new PromptModal(host.app, "Rename image", file.basename, (name) => {
					const base = name.toLowerCase().endsWith(`.${file.extension.toLowerCase()}`) ? name.slice(0, -file.extension.length - 1) : name;
					const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
					return attempt(() => host.app.fileManager.renameFile(file, `${dir}${base}.${file.extension}`));
				}).open();
			}),
	);
	menu.addItem((item) =>
		item
			.setTitle("Move image to...")
			.setIcon("folder-input")
			.setDisabled(!file)
			.onClick(async () => {
				if (!file) return;
				await host.save?.();
				new MoveModal(host.app, [file]).open();
			}),
	);
	menu.showAtMouseEvent(evt);
}

// The image Live Preview shows as its own widget (not one inside a rendered
// block such as a callout) for an <img> under the pointer.
function widgetImage(target: EventTarget | null): HTMLImageElement | null {
	const img = (target as Element | null)?.closest?.("img");
	const wrap = img?.parentElement;
	if (!img || !wrap?.matches(".image-embed, .cm-html-embed") || wrap.closest(".markdown-rendered")) return null;
	return img as HTMLImageElement;
}

// The image ref whose widget starts at `pos`.
function refAt(view: EditorView, pos: number): ImageRef | null {
	const line = view.state.doc.lineAt(pos);
	const ref = findImageRefs(line.text).find((r) => line.from + r.to > pos);
	return ref ? { ...ref, from: line.from + ref.from, to: line.from + ref.to } : null;
}

// Live Preview's image widgets: a double click opens the image menu. A press
// on the image no longer puts the caret beside it at once, which would
// reveal the source under the second click; a single click does that once
// the double-click time has passed.
export function imageMenu(host: ImageMenuHost): Extension {
	let pending: number | null = null;
	return EditorView.domEventHandlers({
		mousedown(evt, view) {
			const img = evt.button === 0 && !evt.shiftKey && !evt.altKey && !evt.metaKey && !evt.ctrlKey ? widgetImage(evt.target) : null;
			if (!img) return false;
			evt.preventDefault();
			if (pending !== null) window.clearTimeout(pending);
			pending = null;
			if (evt.detail >= 2) {
				const ref = refAt(view, view.posAtDOM(img.parentElement!));
				if (ref) openImageMenu(evt, host, view, ref, img);
				return true;
			}
			const { clientX: x, clientY: y } = evt;
			pending = window.setTimeout(() => {
				pending = null;
				if (!img.isConnected) return;
				const pos = view.posAtCoords({ x, y }, false);
				view.dispatch({ selection: { anchor: pos } });
				view.focus();
			}, 300);
			return true;
		},
	});
}

// An image the reading view rendered: which ref it is among the images in
// the source `text` of its section. Images are told apart by the URL they
// load (`resolve` gives a ref's), then by their order among those with the
// same URL; images inside embedded notes are not the section's own.
export function refForRenderedImage(img: HTMLImageElement, sectionEl: HTMLElement, text: string, resolve: (ref: ImageRef) => string | null): ImageRef | null {
	const src = img.getAttribute("src");
	const own = [...sectionEl.querySelectorAll("img")].filter((i) => i.getAttribute("src") === src && !i.parentElement?.closest(".markdown-embed"));
	const index = own.indexOf(img);
	if (index < 0) return null;
	return findImageRefs(text).filter((ref) => resolve(ref) === src)[index] ?? null;
}

// What URL a ref loads in the reading view, given how a link path resolves.
export function renderedSrc(ref: ImageRef, resolveImage: (link: string) => string | null): string | null {
	if (ref.kind === "html") return resolveHtmlSrc(ref.target, resolveImage) ?? (/^[a-z][\w+.-]*:/i.test(ref.target) ? ref.target : null);
	let target = ref.target;
	try {
		target = decodeURI(target);
	} catch {}
	return resolveImage(ref.kind === "wikilink" ? target.split("#")[0] : target);
}
