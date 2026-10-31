// Helpers for links, frontmatter and cached metadata (part of the obsidian module).
export function parseLinktext(linktext: string) {
	const i = linktext.search(/[#^]/);
	return i < 0 ? { path: linktext, subpath: "" } : { path: linktext.slice(0, i), subpath: linktext.slice(i) };
}

export function getLinkpath(linktext: string) {
	return parseLinktext(linktext).path;
}

export function stripHeading(heading: string) {
	return heading.replace(/[!"#$%&()*+,.:;<=>?@^`{|}~/[\]\\]/g, " ").replace(/\s+/g, " ").trim();
}

function asList(value: unknown): string[] | null {
	if (value == null) return null;
	if (Array.isArray(value)) return value.map(String);
	return String(value)
		.split(/[,\s]+/)
		.filter(Boolean);
}

export function parseFrontMatterEntry(frontmatter: any, key: string | RegExp) {
	if (!frontmatter) return null;
	if (typeof key === "string") return frontmatter[key] ?? null;
	for (const k of Object.keys(frontmatter)) if (key.test(k)) return frontmatter[k];
	return null;
}

export function parseFrontMatterStringArray(frontmatter: any, key: string | RegExp) {
	return asList(parseFrontMatterEntry(frontmatter, key));
}

export function parseFrontMatterTags(frontmatter: any) {
	const tags = asList(parseFrontMatterEntry(frontmatter, /^tags?$/i));
	return tags ? tags.map((t) => (t.startsWith("#") ? t : `#${t}`)) : null;
}

export function parseFrontMatterAliases(frontmatter: any) {
	return asList(parseFrontMatterEntry(frontmatter, /^alias(es)?$/i));
}

export function getAllTags(cache: any): string[] | null {
	if (!cache) return null;
	const tags = [...(parseFrontMatterTags(cache.frontmatter) ?? []), ...(cache.tags ?? []).map((t: any) => t.tag)];
	return tags;
}

export function getFrontMatterInfo(content: string) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!m) return { exists: false, frontmatter: "", from: 0, to: 0, contentStart: 0 };
	const from = content.indexOf("\n") + 1;
	return { exists: true, frontmatter: m[1], from, to: from + m[1].length, contentStart: m[0].length };
}

export function iterateCacheRefs(cache: any, cb: (ref: any) => boolean | void) {
	for (const ref of [...(cache?.links ?? []), ...(cache?.embeds ?? []), ...(cache?.frontmatterLinks ?? [])]) {
		if (cb(ref)) return true;
	}
	return false;
}
