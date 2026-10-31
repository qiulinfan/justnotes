// Frontmatter values as Bases sees them: typed by the vault's property types
// (app.metadataTypeManager), with links, URLs and dates recognised in strings.
import type { App } from "../app";
import {
	BooleanValue,
	DateValue,
	LinkValue,
	ListValue,
	NullValue,
	NumberValue,
	ObjectValue,
	StringValue,
	TagValue,
	UrlValue,
	type Value,
	wrap,
} from "./values";

// The type the vault assigns the property (app.metadataTypeManager).
export function propertyType(app: App, name: string): string | null {
	return app.metadataTypeManager?.getAssignedType(name) ?? null;
}

const WEB_URL = /^https?:\/\/\S+$/i;
const ISO_DATE = /^\d{4}-\d\d-\d\d(?:[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d(?::?\d\d)?)?)?$/;

function asArray(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (typeof raw === "string") return raw.split(/[,\s]+/).filter(Boolean);
	return [raw];
}

export function wrapProperty(app: App, name: string, raw: unknown, sourcePath: string): Value {
	return wrapTyped(app, raw, propertyType(app, name), sourcePath);
}

export function wrapTyped(app: App, raw: unknown, type: string | null, sourcePath: string): Value {
	if (raw === null || raw === undefined) return NullValue.value;
	switch (type) {
		case "tags":
			return new ListValue(asArray(raw).filter((t) => t !== null && t !== "").map((t) => new TagValue(String(t))));
		case "aliases":
		case "multitext":
			return new ListValue((Array.isArray(raw) ? raw : [raw]).map((v) => inferValue(app, v, sourcePath)));
		case "date":
		case "datetime": {
			const date = raw instanceof Date ? new DateValue(raw) : typeof raw === "string" ? DateValue.parseFromString(raw) : null;
			if (date) return new DateValue(date.date, type === "datetime");
			break;
		}
		case "number": {
			const n = typeof raw === "number" ? raw : Number(String(raw).trim());
			if (Number.isFinite(n) && String(raw).trim() !== "") return new NumberValue(n);
			break;
		}
		case "checkbox":
			if (typeof raw === "boolean") return new BooleanValue(raw);
			if (raw === "true" || raw === "false") return new BooleanValue(raw === "true");
			break;
		case "text":
			if (typeof raw === "string") return LinkValue.parseFromString(app, raw, sourcePath) ?? (WEB_URL.test(raw.trim()) ? new UrlValue(raw.trim()) : new StringValue(raw));
	}
	return inferValue(app, raw, sourcePath);
}

// A value without an assigned type: wikilinks become links, URLs URLs, and
// ISO dates dates, as Obsidian infers them.
export function inferValue(app: App, raw: unknown, sourcePath: string): Value {
	if (typeof raw === "string") {
		const link = LinkValue.parseFromString(app, raw, sourcePath);
		if (link) return link;
		const text = raw.trim();
		if (WEB_URL.test(text)) return new UrlValue(text);
		if (ISO_DATE.test(text)) return DateValue.parseFromString(text) ?? new StringValue(raw);
		return new StringValue(raw);
	}
	if (Array.isArray(raw)) return new ListValue(raw.map((v) => inferValue(app, v, sourcePath)));
	if (raw && typeof raw === "object" && !(raw instanceof Date)) {
		return new ObjectValue(raw as Record<string, unknown>, (_k, v) => inferValue(app, v, sourcePath));
	}
	return wrap(raw);
}
