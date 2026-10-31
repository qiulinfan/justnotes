// Edits to a note's frontmatter YAML that rewrite only the property they
// change: the other properties keep their bytes (order, quoting, comments,
// list style), and the changed one keeps the list and quote style it had.
// The YAML is the text between the `---` lines, ending in a newline when it
// is not empty.
import * as YAML from "yaml";
import { locateFrontMatter } from "./metadata-utils";

export type PropertyEntries = [string, unknown][];

interface Entry {
	key: string;
	// The entry's lines: from the start of its key's line to the end of the
	// line its value ends on (a comment there included), without the newline.
	from: number;
	to: number;
	keyFrom: number;
	keyTo: number;
	keyType: string | undefined;
	// A comment after a one-line value (`key: value  # note`).
	comment: string;
	value: unknown;
	style: Style;
}

interface Style {
	flow: boolean;
	// Block list items indented under the key ("  - a") or not ("- a").
	indentSeq: boolean | undefined;
	quote: string | undefined;
	itemQuotes: Map<string, string>;
}

interface Parsed {
	doc: YAML.Document.Parsed;
	entries: Entry[];
	// Every key starts its own line, so entries can be rewritten one by one.
	lineWise: boolean;
}

const QUOTES = new Set(["QUOTE_DOUBLE", "QUOTE_SINGLE"]);

function lineStart(text: string, pos: number) {
	return text.lastIndexOf("\n", pos - 1) + 1;
}

function lineEnd(text: string, pos: number) {
	const i = text.indexOf("\n", pos);
	return i < 0 ? text.length : i;
}

function styleOf(text: string, keyFrom: number, node: unknown): Style {
	const style: Style = { flow: false, indentSeq: undefined, quote: undefined, itemQuotes: new Map() };
	if (YAML.isSeq(node)) {
		style.flow = !!node.flow;
		const first = node.items[0];
		if (!style.flow && YAML.isNode(first) && first.range) {
			// The item's dash is the first non-space character of its line.
			const start = lineStart(text, first.range[0]);
			const indent = /^ */.exec(text.slice(start))![0].length;
			style.indentSeq = indent > keyFrom - lineStart(text, keyFrom);
		}
		for (const item of node.items) {
			if (YAML.isScalar(item) && typeof item.value === "string" && item.type && QUOTES.has(item.type)) style.itemQuotes.set(item.value, item.type);
		}
	} else if (YAML.isScalar(node) && node.type && QUOTES.has(node.type)) {
		style.quote = node.type;
	}
	return style;
}

function parse(yaml: string): Parsed | null {
	const doc = YAML.parseDocument(yaml);
	if (doc.errors.length) return null;
	const contents = doc.contents;
	if (contents === null) return { doc, entries: [], lineWise: true };
	if (!YAML.isMap(contents)) return null;
	const entries: Entry[] = [];
	let lineWise = !contents.flow;
	for (const pair of contents.items) {
		const keyNode = pair.key;
		const key = YAML.isScalar(keyNode) ? keyNode.value : keyNode;
		if (typeof key !== "string" && typeof key !== "number" && typeof key !== "boolean") return null;
		if (!YAML.isScalar(keyNode) || !keyNode.range) return null;
		const [keyFrom, keyTo] = keyNode.range;
		const valueNode = pair.value;
		let end = YAML.isNode(valueNode) && valueNode.range ? valueNode.range[1] : keyTo;
		while (end > keyTo && /\s/.test(yaml[end - 1])) end--;
		const from = lineStart(yaml, keyFrom);
		if (from !== keyFrom) lineWise = false;
		const to = lineEnd(yaml, end);
		const tail = yaml.slice(end, to);
		entries.push({
			key: String(key),
			from,
			to,
			comment: !yaml.slice(from, end).includes("\n") && /^\s+#/.test(tail) ? tail : "",
			keyFrom,
			keyTo,
			keyType: keyNode.type,
			value: YAML.isNode(valueNode) ? valueNode.toJSON() : (valueNode ?? null),
			style: styleOf(yaml, keyFrom, valueNode),
		});
	}
	return { doc, entries, lineWise };
}

// The properties in order, or null when the YAML is not a map of properties
// (invalid, a list, duplicate keys).
export function readProperties(yaml: string): PropertyEntries | null {
	const parsed = parse(yaml);
	return parsed ? parsed.entries.map((e) => [e.key, e.value]) : null;
}

// The style new entries follow: that of the note's block lists, else
// Obsidian's (indented items).
function defaultIndent(entries: Entry[]) {
	return entries.find((e) => e.style.indentSeq !== undefined)?.style.indentSeq ?? true;
}

function keyText(key: string, type?: string) {
	const scalar = new YAML.Scalar(key);
	if (type && QUOTES.has(type)) scalar.type = type as YAML.Scalar.Type;
	return new YAML.Document(scalar).toString({ lineWidth: 0 }).replace(/\n$/, "");
}

function entryText(key: string, value: unknown, style: Style | null, indentSeq: boolean, keyType?: string) {
	const doc = new YAML.Document({});
	const node = doc.createNode(value ?? null);
	if (YAML.isSeq(node)) {
		node.flow = !!style?.flow;
		for (const item of node.items) {
			if (YAML.isScalar(item) && typeof item.value === "string") {
				const quote = style?.itemQuotes.get(item.value);
				if (quote) item.type = quote as YAML.Scalar.Type;
			}
		}
	} else if (YAML.isScalar(node) && typeof node.value === "string" && style?.quote) {
		node.type = style.quote as YAML.Scalar.Type;
	}
	const keyNode = new YAML.Scalar(key);
	if (keyType && QUOTES.has(keyType)) keyNode.type = keyType as YAML.Scalar.Type;
	(doc.contents as YAML.YAMLMap).items.push(new YAML.Pair(keyNode, node));
	return doc.toString({ lineWidth: 0, nullStr: "", indentSeq: style?.indentSeq ?? indentSeq, flowCollectionPadding: false }).replace(/\n$/, "");
}

const finish = (text: string) => (text.trim() ? text.replace(/\n*$/, "\n") : "");

function splice(yaml: string, from: number, to: number, insert: string) {
	return finish(yaml.slice(0, from) + insert + yaml.slice(to));
}

// Rewrites the whole map, for YAML whose keys do not each start a line (a
// flow map): the values survive, the formatting does not.
function rewrite(parsed: Parsed, entries: PropertyEntries) {
	const doc = new YAML.Document(Object.fromEntries(entries));
	return finish(doc.toString({ lineWidth: 0, nullStr: "" }));
}

function current(parsed: Parsed): PropertyEntries {
	return parsed.entries.map((e) => [e.key, e.value]);
}

// Sets a property's value; a property the YAML lacks is added at the end.
// YAML that is not a map of properties is returned unchanged.
function setPropertyLf(yaml: string, key: string, value: unknown): string {
	const parsed = parse(yaml);
	if (!parsed) return yaml;
	const entry = parsed.entries.find((e) => e.key === key);
	if (!entry) return insertPropertyLf(yaml, key, value);
	if (!parsed.lineWise) return rewrite(parsed, current(parsed).map(([k, v]) => [k, k === key ? value : v]));
	const text = entryText(key, value, entry.style, defaultIndent(parsed.entries), entry.keyType);
	return splice(yaml, entry.from, entry.to, text.includes("\n") ? text : text + entry.comment);
}

// Adds a property before the one at `index`, or at the end. A key the YAML
// already has is set instead.
function insertPropertyLf(yaml: string, key: string, value: unknown, index?: number): string {
	const parsed = parse(yaml);
	if (!parsed) return yaml;
	if (parsed.entries.some((e) => e.key === key)) return setPropertyLf(yaml, key, value);
	const entries = parsed.entries;
	const at = index === undefined || index >= entries.length ? null : entries[Math.max(0, index)];
	if (!parsed.lineWise) {
		const list = current(parsed);
		list.splice(at ? entries.indexOf(at) : list.length, 0, [key, value]);
		return rewrite(parsed, list);
	}
	const text = entryText(key, value, null, defaultIndent(entries));
	if (at) return splice(yaml, at.from, at.from, `${text}\n`);
	const body = yaml.replace(/\s*$/, "");
	return finish(body ? `${body}\n${text}` : text);
}

// Removes a property with its lines.
function removePropertyLf(yaml: string, key: string): string {
	const parsed = parse(yaml);
	const entry = parsed?.entries.find((e) => e.key === key);
	if (!parsed || !entry) return yaml;
	if (!parsed.lineWise) return rewrite(parsed, current(parsed).filter(([k]) => k !== key));
	const to = entry.to < yaml.length ? entry.to + 1 : entry.to;
	return splice(yaml, entry.from, to, "");
}

// Renames a property in place, keeping its value as written. Renaming to a
// key the YAML already has (another property) changes nothing.
function renamePropertyLf(yaml: string, from: string, to: string): string {
	if (from === to) return yaml;
	const parsed = parse(yaml);
	const entry = parsed?.entries.find((e) => e.key === from);
	if (!parsed || !entry || !to || parsed.entries.some((e) => e.key === to)) return yaml;
	if (!parsed.lineWise) return rewrite(parsed, current(parsed).map(([k, v]) => [k === from ? to : k, v]));
	return splice(yaml, entry.keyFrom, entry.keyTo, keyText(to, entry.keyType));
}

// Moves a property to position `index` among the others.
function movePropertyLf(yaml: string, key: string, index: number): string {
	const parsed = parse(yaml);
	const entry = parsed?.entries.find((e) => e.key === key);
	if (!parsed || !entry) return yaml;
	const others = parsed.entries.filter((e) => e !== entry);
	const at = Math.max(0, Math.min(index, others.length));
	if (parsed.entries.indexOf(entry) === at) return yaml;
	if (!parsed.lineWise) {
		const list = current(parsed).filter(([k]) => k !== key);
		list.splice(at, 0, [key, entry.value]);
		return rewrite(parsed, list);
	}
	const text = yaml.slice(entry.from, entry.to);
	const without = removePropertyLf(yaml, key);
	const next = parse(without)!.entries[at];
	if (next) return splice(without, next.from, next.from, `${text}\n`);
	return finish(`${without.replace(/\s*$/, "")}\n${text}`);
}

// A YAML with CRLF line breaks is edited as LF and given CRLF back, so the
// lines an edit writes end as the others do; an edit that changes nothing
// returns the YAML as it was.
function keepEol(yaml: string, edit: (lf: string) => string) {
	if (!yaml.includes("\r\n")) return edit(yaml);
	const lf = yaml.replace(/\r\n/g, "\n");
	const out = edit(lf);
	return out === lf ? yaml : out.replace(/\n/g, "\r\n");
}

export const setProperty = (yaml: string, key: string, value: unknown) => keepEol(yaml, (lf) => setPropertyLf(lf, key, value));
export const insertProperty = (yaml: string, key: string, value: unknown, index?: number) => keepEol(yaml, (lf) => insertPropertyLf(lf, key, value, index));
export const removeProperty = (yaml: string, key: string) => keepEol(yaml, (lf) => removePropertyLf(lf, key));
export const renameProperty = (yaml: string, from: string, to: string) => keepEol(yaml, (lf) => renamePropertyLf(lf, from, to));
export const moveProperty = (yaml: string, key: string, index: number) => keepEol(yaml, (lf) => movePropertyLf(lf, key, index));

// The frontmatter of a note's text: `yamlFrom`..`yamlTo` is the YAML (its
// last newline included), and `to` the end of the closing `---` line (its
// newline included). Null when the note has no closed frontmatter.
export function locateFrontmatter(text: string): { yamlFrom: number; yamlTo: number; to: number } | null {
	const fm = locateFrontMatter(text);
	if (!fm) return null;
	const eol = (pos: number) => (text.startsWith("\r\n", pos) ? 2 : text[pos] === "\n" ? 1 : 0);
	return { yamlFrom: fm.from, yamlTo: fm.to > fm.from ? fm.to + eol(fm.to) : fm.from, to: fm.end + eol(fm.end) };
}

// The note's text with its frontmatter YAML replaced; an empty `yaml` drops
// the whole block, and a note without one gets one.
export function replaceFrontmatter(text: string, yaml: string): string {
	const fm = locateFrontmatter(text);
	if (!yaml) return fm ? text.slice(fm.to) : text;
	if (fm) return text.slice(0, fm.yamlFrom) + yaml + text.slice(fm.yamlTo);
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	return `---${eol}${eol === "\n" ? yaml : yaml.replace(/\r?\n/g, eol)}---${eol}${text}`;
}
