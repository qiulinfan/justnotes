import * as nodePath from "node:path";

// Media that raw HTML in a note points at (`<img src>`, as Typora writes
// images, and video, audio and source), which the metadata cache does not
// index as links. FileManager.renameFile keeps the relative ones pointing
// at their files.

export interface HtmlSrc {
	// The attribute value's place in the text, quotes excluded.
	from: number;
	to: number;
	value: string;
}

const MEDIA_TAG = /<(?:img|video|audio|source)\b[^>]*>/gi;
const SRC_ATTR = /(\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

// The text with fenced code, inline code and HTML comments blanked out
// (same length, line breaks kept), so nothing in them is taken for a tag.
function maskCode(text: string) {
	const blank = (s: string) => s.replace(/[^\n]/g, " ");
	const lines = text.split("\n");
	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
		if (fence) {
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2].trim()) fence = null;
		} else if (m) fence = m[1];
		else continue;
		lines[i] = blank(lines[i]);
	}
	let out = lines.join("\n");
	out = out.replace(/<!--[\s\S]*?-->/g, blank);
	return out.replace(/(`+)[^`\n]*?\1/g, blank);
}

export function htmlMediaSrcs(text: string): HtmlSrc[] {
	const out: HtmlSrc[] = [];
	for (const tag of maskCode(text).matchAll(MEDIA_TAG)) {
		const m = SRC_ATTR.exec(tag[0]);
		if (!m) continue;
		const quoted = m[2] !== undefined || m[3] !== undefined;
		const value = m[2] ?? m[3] ?? m[4];
		const from = tag.index + m.index + m[1].length + (quoted ? 1 : 0);
		out.push({ from, to: from + value.length, value: text.slice(from, from + value.length) });
	}
	return out;
}

// The vault path a src names relative to the note at `sourcePath`, as
// Typora and browsers read it (backslashes, a leading "./" and %-escapes
// allowed); null for URLs, absolute paths and anything outside the vault.
export function srcVaultPath(src: string, sourcePath: string): string | null {
	if (!src || /^[a-z][\w+.-]*:/i.test(src) || /^[\\/#]/.test(src)) return null;
	let path = src.replace(/\\/g, "/");
	try {
		path = decodeURIComponent(path);
	} catch {}
	const joined = nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(sourcePath || "x"), path));
	return joined === "." || joined.startsWith("../") ? null : joined;
}

// The src naming `filePath` from the note at `sourcePath`, written as `old`
// was: with backslashes or %-escapes when it used them.
export function rewrittenSrc(old: string, sourcePath: string, filePath: string): string {
	let src = nodePath.posix.relative(nodePath.posix.dirname(sourcePath || "x"), filePath);
	if (old.startsWith("./") && !src.startsWith("../")) src = `./${src}`;
	if (/%[0-9a-f]{2}/i.test(old)) src = encodeURI(src).replace(/#/g, "%23");
	else src = src.replace(/"/g, "%22");
	if (old.includes("\\") && !old.includes("/")) src = src.replace(/\//g, "\\");
	return src;
}
