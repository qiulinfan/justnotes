import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { resolveHtmlSrc } from "./markdown";
import { Menu } from "./ui/menu";

// Double-clicking an image in a note offers zoom presets that rewrite the
// image's size in the source: an HTML <img>'s `zoom` style (Typora's), a
// wikilink or Markdown embed's width (from the image's natural width).

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

// The menu of zoom presets and Reset at the pointer.
export function showImageZoomMenu(evt: MouseEvent, current: number | null, pick: (zoom: number | null) => void) {
	const menu = new Menu();
	for (const zoom of ZOOM_PRESETS) {
		menu.addItem((item) =>
			item
				.setTitle(`${zoom}%`)
				.setChecked(current === zoom)
				.onClick(() => pick(zoom)),
		);
	}
	menu.addSeparator();
	menu.addItem((item) =>
		item
			.setTitle("Reset")
			.setIcon("rotate-ccw")
			.onClick(() => pick(null)),
	);
	menu.showAtMouseEvent(evt);
}

// The zoom menu for the image `ref` (positions in `view`'s document); a
// pick rewrites it as one undoable change, then `changed` runs.
export function openZoomMenu(evt: MouseEvent, view: EditorView, ref: ImageRef, img: HTMLImageElement, changed?: () => void) {
	const text = view.state.sliceDoc(ref.from, ref.to);
	showImageZoomMenu(evt, currentZoom(text, ref.kind, img.naturalWidth), (zoom) => {
		// The note may have changed while the menu was open.
		if (view.state.sliceDoc(ref.from, ref.to) !== text) return;
		const next = zoomImageSource(text, ref.kind, zoom, img.naturalWidth);
		if (next === text) return;
		view.dispatch({ changes: { from: ref.from, to: ref.to, insert: next } });
		changed?.();
	});
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

// Live Preview's image widgets: a double click opens the zoom menu. A press
// on the image no longer puts the caret beside it at once, which would
// reveal the source under the second click; a single click does that once
// the double-click time has passed.
export function imageZoom(): Extension {
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
				if (ref) openZoomMenu(evt, view, ref, img);
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
