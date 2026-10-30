import moment from "moment";
import TurndownService from "turndown";
import * as YAML from "yaml";

export { moment };

export const apiVersion = "1.14.5";

export function normalizePath(path: string) {
	path = path.replace(/[\\  ]/g, (c) => (c === "\\" ? "/" : " "));
	path = path.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
	return path === "" ? "/" : path.normalize("NFC");
}

export interface Debouncer<T extends unknown[], V> {
	(...args: T): Debouncer<T, V>;
	cancel(): Debouncer<T, V>;
	run(): V | void;
}

export function debounce<T extends unknown[], V>(cb: (...args: T) => V, timeout = 0, resetTimer = false): Debouncer<T, V> {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending: T | null = null;
	const fire = () => {
		timer = null;
		const args = pending;
		pending = null;
		return args ? cb(...args) : undefined;
	};
	const d = ((...args: T) => {
		pending = args;
		if (timer && resetTimer) {
			clearTimeout(timer);
			timer = null;
		}
		if (!timer) timer = setTimeout(fire, timeout);
		return d;
	}) as Debouncer<T, V>;
	d.cancel = () => {
		if (timer) clearTimeout(timer);
		timer = null;
		pending = null;
		return d;
	};
	d.run = () => {
		if (timer) clearTimeout(timer);
		return fire();
	};
	return d;
}

export function parseYaml(text: string) {
	return YAML.parse(text);
}

export function stringifyYaml(obj: any) {
	return YAML.stringify(obj);
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment) {
	return turndown.turndown(html as any);
}

export function sanitizeHTMLToDom(html: string) {
	const tpl = document.createElement("template");
	tpl.innerHTML = html;
	for (const el of tpl.content.querySelectorAll("script, iframe, object, embed")) el.remove();
	for (const el of tpl.content.querySelectorAll("*")) {
		for (const attr of [...el.attributes]) if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
	}
	return tpl.content;
}

export function getLanguage() {
	return window.localStorage.getItem("language") || navigator.language.split("-")[0] || "en";
}

const isMac = process.platform === "darwin";
export const Platform = {
	isDesktop: true,
	isMobile: false,
	isDesktopApp: true,
	isMobileApp: false,
	isIosApp: false,
	isAndroidApp: false,
	isPhone: false,
	isTablet: false,
	isMacOS: isMac,
	isWin: process.platform === "win32",
	isLinux: process.platform === "linux",
	isSafari: false,
	resourcePathPrefix: "file:///",
};

// requestUrl runs from Node so plugins are not limited by CORS, as in Obsidian.
export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export function requestUrl(request: RequestUrlParam | string) {
	const req = typeof request === "string" ? { url: request } : request;
	const promise = (async () => {
		const headers = { ...req.headers };
		if (req.contentType) headers["content-type"] = req.contentType;
		const res = await fetch(req.url, { method: req.method ?? "GET", headers, body: req.body as any });
		const arrayBuffer = await res.arrayBuffer();
		const text = new TextDecoder().decode(arrayBuffer);
		const response = {
			status: res.status,
			headers: Object.fromEntries(res.headers.entries()),
			arrayBuffer,
			text,
			get json() {
				return JSON.parse(text);
			},
		};
		if (res.status >= 400 && req.throw !== false) {
			throw Object.assign(new Error(`Request failed, status ${res.status}`), response);
		}
		return response;
	})();
	return Object.assign(promise, {
		arrayBuffer: promise.then((r) => r.arrayBuffer),
		text: promise.then((r) => r.text),
		json: promise.then((r) => r.json),
	});
}

export async function request(req: RequestUrlParam | string) {
	return (await requestUrl(req)).text;
}

// Search helpers. A match is a list of [start, end) ranges within the text.
export interface SearchResult {
	score: number;
	matches: [number, number][];
}

export function prepareFuzzySearch(query: string) {
	const q = query.toLowerCase().replace(/\s+/g, "");
	return (text: string): SearchResult | null => {
		if (!q) return { score: 0, matches: [] };
		const t = text.toLowerCase();
		const matches: [number, number][] = [];
		let qi = 0;
		let score = 0;
		let last = -1;
		for (let i = 0; i < t.length && qi < q.length; i++) {
			if (t[i] !== q[qi]) continue;
			const prev = matches[matches.length - 1];
			if (prev && prev[1] === i) prev[1] = i + 1;
			else matches.push([i, i + 1]);
			// Reward consecutive runs and word starts; penalize gaps.
			score -= last >= 0 ? (i - last - 1) * 0.1 : i * 0.05;
			if (i === 0 || /[\s\-_/.:]/.test(t[i - 1])) score += 0.5;
			last = i;
			qi++;
		}
		return qi === q.length ? { score, matches } : null;
	};
}

export function prepareSimpleSearch(query: string) {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	return (text: string): SearchResult | null => {
		const t = text.toLowerCase();
		const matches: [number, number][] = [];
		for (const w of words) {
			const i = t.indexOf(w);
			if (i < 0) return null;
			matches.push([i, i + w.length]);
		}
		return { score: -matches.length, matches: matches.sort((a, b) => a[0] - b[0]) };
	};
}

export function fuzzySearch(q: { query: string }, text: string) {
	return prepareFuzzySearch(q.query)(text);
}

export function sortSearchResults(results: { match: SearchResult }[]) {
	results.sort((a, b) => b.match.score - a.match.score);
}

export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: [number, number][] | null, offset = 0) {
	let pos = 0;
	for (const [s, e] of matches ?? []) {
		const start = s - offset;
		const end = e - offset;
		if (end <= 0 || start >= text.length) continue;
		if (start > pos) el.appendText(text.slice(pos, start));
		el.createSpan({ cls: "suggestion-highlight", text: text.slice(Math.max(start, pos), end) });
		pos = end;
	}
	if (pos < text.length) el.appendText(text.slice(pos));
}

export function renderResults(el: HTMLElement, text: string, result: SearchResult, offset?: number) {
	renderMatches(el, text, result.matches, offset);
}

// Metadata helpers shared with the metadata cache.
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

export function arrayBufferToBase64(buffer: ArrayBuffer) {
	return Buffer.from(buffer).toString("base64");
}

export function base64ToArrayBuffer(base64: string) {
	const b = Buffer.from(base64, "base64");
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

export function arrayBufferToHex(buffer: ArrayBuffer) {
	return Buffer.from(buffer).toString("hex");
}

export function hexToArrayBuffer(hex: string) {
	const b = Buffer.from(hex, "hex");
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

export async function getBlobArrayBuffer(blob: Blob) {
	return blob.arrayBuffer();
}
