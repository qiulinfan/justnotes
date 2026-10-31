// Helpers for links, frontmatter and cached metadata (part of the obsidian module).
import type {
	BlockSubpathResult,
	CachedMetadata,
	FootnoteSubpathResult,
	HeadingCache,
	HeadingSubpathResult,
	Loc,
	Reference,
	ReferenceCache,
} from "./metadata";

export function parseLinktext(linktext: string) {
	const i = linktext.indexOf("#");
	return i < 0 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

export function getLinkpath(linktext: string) {
	return parseLinktext(linktext).path;
}

export function stripHeading(heading: string) {
	return heading.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g, " ").replace(/\s+/g, " ").trim();
}

// Drops the characters that would end or break a [[link#heading]].
export function stripHeadingForLink(heading: string) {
	return heading.replace(/[:#|^\\\r\n]|%%|\[\[|\]\]/g, " ").replace(/\s+/g, " ").trim();
}

// The frontmatter block: '---' on the first line up to the next '---' line,
// possibly empty. `from`/`to` delimit the YAML and `end` is just past the
// closing dashes. parseMetadata, getFrontMatterInfo and processFrontMatter
// all use this, so they agree on where a note's frontmatter is.
export function locateFrontMatter(text: string) {
	const m = /^---[ \t]*\r?\n(?:---|([\s\S]*?)\r?\n---)[ \t]*(?=\r?\n|$)/.exec(text);
	if (!m) return null;
	const from = text.indexOf("\n") + 1;
	return { from, to: from + (m[1]?.length ?? 0), end: m[0].length };
}

export function getFrontMatterInfo(content: string) {
	const fm = locateFrontMatter(content);
	if (!fm) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
	return { exists: true, frontmatter: content.slice(fm.from, fm.to), from: fm.from, to: fm.to, contentStart: fm.end };
}

export function parseFrontMatterEntry(frontmatter: any, key: string | RegExp) {
	if (!frontmatter) return null;
	if (typeof key === "string") return frontmatter[key] ?? null;
	for (const k of Object.keys(frontmatter)) if (key.test(k)) return frontmatter[k];
	return null;
}

// Every value under the matching keys, as trimmed non-empty strings.
function stringValues(frontmatter: any, key: string | RegExp, split?: RegExp) {
	if (!frontmatter || typeof frontmatter !== "object") return null;
	const keys = typeof key === "string" ? (key in frontmatter ? [key] : []) : Object.keys(frontmatter).filter((k) => key.test(k));
	if (!keys.length) return null;
	const out: string[] = [];
	for (const k of keys) {
		const value = frontmatter[k];
		for (const item of Array.isArray(value) ? value : [value]) {
			if (typeof item !== "string") continue;
			for (const part of split ? item.split(split) : [item]) if (part.trim()) out.push(part.trim());
		}
	}
	return out.length ? out : null;
}

export function parseFrontMatterStringArray(frontmatter: any, key: string | RegExp) {
	return stringValues(frontmatter, key);
}

export function parseFrontMatterTags(frontmatter: any) {
	const tags = stringValues(frontmatter, /^tags?$/i, /[,\s]+/);
	return tags ? tags.map((t) => (t.startsWith("#") ? t : `#${t}`)) : null;
}

export function parseFrontMatterAliases(frontmatter: any) {
	return stringValues(frontmatter, /^alias(es)?$/i, /,/);
}

export function getAllTags(cache: CachedMetadata | null): string[] | null {
	if (!cache) return null;
	const tags = [...(parseFrontMatterTags(cache.frontmatter) ?? []), ...(cache.tags ?? []).map((t) => t.tag)];
	return tags.length ? tags : null;
}

export function iterateRefs(refs: Reference[], cb: (ref: Reference) => boolean | void) {
	for (const ref of refs) if (cb(ref)) return true;
	return false;
}

export function iterateCacheRefs(cache: CachedMetadata, cb: (ref: ReferenceCache) => boolean | void) {
	return iterateRefs([...(cache?.links ?? []), ...(cache?.embeds ?? [])], cb as (ref: Reference) => boolean | void);
}

// '#Heading', '#Parent#Child', '#^blockid' or '#[^footnote]' within a note.
// Headings match after stripHeading, ignoring case.
export function resolveSubpath(cache: CachedMetadata, subpath: string): HeadingSubpathResult | BlockSubpathResult | FootnoteSubpathResult | null {
	if (!cache) return null;
	const sub = subpath.replace(/^#/, "");
	const footnote = /^\[\^(.+)\]$/.exec(sub);
	if (footnote) {
		const found = cache.footnotes?.find((f) => f.id === footnote[1]);
		return found ? { type: "footnote", footnote: found, start: found.position.start, end: found.position.end } : null;
	}
	if (sub.startsWith("^")) {
		const block = cache.blocks?.[sub.slice(1).toLowerCase()];
		if (!block) return null;
		const list = cache.listItems?.find((l) => l.position.start.line === block.position.start.line);
		return { type: "block", block, list, start: block.position.start, end: block.position.end };
	}
	const parts = sub
		.split("#")
		.map((p) => stripHeading(p).toLowerCase())
		.filter(Boolean);
	const headings = cache.headings ?? [];
	if (!parts.length) return null;
	// Each part must be found, in order, as a heading nested under the previous one.
	let index = -1;
	let level = 0;
	for (const part of parts) {
		let found = -1;
		for (let i = index + 1; i < headings.length; i++) {
			if (index >= 0 && headings[i].level <= level) break;
			if (stripHeading(headings[i].heading).toLowerCase() === part) {
				found = i;
				break;
			}
		}
		if (found < 0) return null;
		index = found;
		level = headings[found].level;
	}
	const current = headings[index];
	const next = headings.slice(index + 1).find((h) => h.level <= current.level) as HeadingCache | undefined;
	const end: Loc | null = next ? next.position.start : null;
	return { type: "heading", current, next: next as HeadingCache, start: current.position.start, end };
}
