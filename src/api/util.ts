import moment from "moment";
import TurndownService from "turndown";
import * as YAML from "yaml";
import type { RequestParams } from "../main/ipc";

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

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
// The GFM and Obsidian syntax plain turndown drops.
turndown.addRule("strikethrough", { filter: ["del", "s"], replacement: (content) => `~~${content}~~` });
turndown.addRule("highlight", { filter: "mark", replacement: (content) => `==${content}==` });
turndown.addRule("taskListItem", {
	filter: (node) => node.nodeName === "INPUT" && node.getAttribute("type") === "checkbox" && node.parentNode?.nodeName === "LI",
	replacement: (_content, node) => {
		const mark = (node as HTMLInputElement).checked || (node as HTMLElement).hasAttribute("checked") ? "[x]" : "[ ]";
		return /^\s/.test(node.nextSibling?.textContent ?? "") ? mark : `${mark} `;
	},
});
turndown.addRule("table", {
	filter: "table",
	replacement: (_content, node) => `\n\n${tableToMarkdown(node as HTMLTableElement)}\n\n`,
});

function tableToMarkdown(table: HTMLTableElement) {
	const rows = Array.from(table.querySelectorAll("tr")).filter((tr) => tr.closest("table") === table);
	const cells = rows.map((tr) =>
		Array.from(tr.children)
			.filter((cell) => cell.nodeName === "TD" || cell.nodeName === "TH")
			.map((cell) => turndown.turndown(cell.innerHTML).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim()),
	);
	if (cells.length === 0) return "";
	const width = Math.max(...cells.map((row) => row.length));
	const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
	return [line(cells[0]), line(Array(width).fill("---")), ...cells.slice(1).map(line)].join("\n");
}

export function htmlToMarkdown(html: string | HTMLElement | Document | DocumentFragment) {
	return turndown.turndown(html as any);
}

// The app language, "en" unless one was chosen; never the OS locale.
export function getLanguage() {
	return window.localStorage.getItem("language") || "en";
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

export interface RequestUrlParam {
	url: string;
	method?: string;
	contentType?: string;
	body?: string | ArrayBuffer;
	headers?: Record<string, string>;
	throw?: boolean;
}

export interface RequestUrlResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer: ArrayBuffer;
	json: any;
	text: string;
}

export interface RequestUrlResponsePromise extends Promise<RequestUrlResponse> {
	arrayBuffer: Promise<ArrayBuffer>;
	json: Promise<any>;
	text: Promise<string>;
}

// What the main process returns for one request: the response, with header
// names lower-cased, or why it could not be made.
export type RawResponse = { status: number; headers: Record<string, string>; body: ArrayBuffer } | { error: string };

function responseOf(raw: { status: number; headers: Record<string, string>; body: ArrayBuffer }): RequestUrlResponse {
	let text: string | undefined;
	let json: { value: any } | undefined;
	return {
		status: raw.status,
		headers: raw.headers,
		arrayBuffer: raw.body,
		get text() {
			text ??= new TextDecoder().decode(raw.body);
			return text;
		},
		// Parsed on first read, so a body that is not JSON only throws when used.
		get json() {
			json ??= { value: JSON.parse(this.text) };
			return json.value;
		},
	};
}

// Turns the main process's answer into the response, or into the rejection a
// status of 400 or more causes unless `throw: false`. The error carries the
// response's fields; reading them never parses the body.
export function settleRequest(req: RequestUrlParam, raw: RawResponse): RequestUrlResponse {
	if ("error" in raw) throw new Error(raw.error);
	const response = responseOf(raw);
	if (response.status < 400 || req.throw === false) return response;
	const err = new Error(`Request failed, status ${response.status}`);
	for (const key of ["status", "headers", "arrayBuffer", "text", "json"] as const) {
		Object.defineProperty(err, key, { get: () => response[key], enumerable: true });
	}
	throw err;
}

// Like Obsidian, requests leave the browser: the main process makes them with
// Node's http and https (main/ipc.ts), so headers such as User-Agent or Cookie
// go out as given and no CORS rules apply.
export function requestUrl(request: RequestUrlParam | string): RequestUrlResponsePromise {
	const req = typeof request === "string" ? { url: request } : request;
	const promise = (async () => {
		const { ipcRenderer } = require("electron");
		const params: RequestParams = {
			url: req.url,
			method: req.method ?? "GET",
			headers: req.headers ?? {},
			contentType: req.contentType,
			body: req.body,
		};
		const raw: RawResponse = await ipcRenderer.invoke("justnotes:request-url", params);
		return settleRequest(req, raw);
	})();
	// The shortcuts are made on first access, so a failed request the caller
	// awaits directly does not also reject three unwatched promises.
	return Object.defineProperties(promise, {
		arrayBuffer: { get: () => promise.then((r) => r.arrayBuffer) },
		json: { get: () => promise.then((r) => r.json) },
		text: { get: () => promise.then((r) => r.text) },
	}) as RequestUrlResponsePromise;
}

export async function request(req: RequestUrlParam | string) {
	return (await requestUrl(req)).text;
}

// Search helpers. A match is a list of [start, end) ranges within the text.
export interface SearchResult {
	score: number;
	matches: [number, number][];
}

// The best of the greedy matches that start at each occurrence of the query's
// first letter: from the first one alone, "qa new" would match "QuickAdd: New
// note from template" better than "QuickAdd: QA New".
export function prepareFuzzySearch(query: string) {
	const q = query.toLowerCase().replace(/\s+/g, "");
	return (text: string): SearchResult | null => {
		if (!q) return { score: 0, matches: [] };
		const t = text.toLowerCase();
		let best: SearchResult | null = null;
		for (let start = t.indexOf(q[0]); start >= 0; start = t.indexOf(q[0], start + 1)) {
			const result = fuzzyMatchFrom(t, q, start);
			// A later start has fewer letters left, so it cannot match either.
			if (!result) break;
			if (!best || result.score > best.score) best = result;
		}
		return best;
	};
}

function fuzzyMatchFrom(t: string, q: string, start: number): SearchResult | null {
	const matches: [number, number][] = [];
	let qi = 0;
	let score = 0;
	let last = -1;
	for (let i = start; i < t.length && qi < q.length; i++) {
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

// The deprecated prepared query older plugins pass to fuzzySearch.
export function prepareQuery(query: string) {
	return { query, tokens: query.split(/\s+/).filter(Boolean), fuzzy: query.toLowerCase().split("") };
}

export function fuzzySearch(q: { query: string }, text: string) {
	return prepareFuzzySearch(q.query)(text);
}

export function sortSearchResults(results: { match: SearchResult }[]) {
	results.sort((a, b) => b.match.score - a.match.score);
}

// `offset` is added to every match position, so a match against a longer
// string (a path) can highlight a part of it (the basename).
export function renderMatches(el: HTMLElement | DocumentFragment, text: string, matches: [number, number][] | null, offset = 0) {
	let pos = 0;
	for (const [s, e] of matches ?? []) {
		const start = s + offset;
		const end = e + offset;
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
