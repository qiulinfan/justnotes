// The .base file: its YAML schema, the parsed configuration and the view config
// plugin views read. The YAML stays the source of truth; edits are applied to
// the parsed YAML document, so comments and unknown keys survive.
import * as YAML from "yaml";
import { type BasesPropertyId, FILE_PROPERTIES, normalizePropertyId, parsePropertyId } from "./property";
import { ErrorValue, NullValue, type Value } from "./values";

export type BasesConfigFileFilter = string | { and: BasesConfigFileFilter[] } | { or: BasesConfigFileFilter[] } | { not: BasesConfigFileFilter[] };

export interface BasesConfigFileView {
	type: string;
	name: string;
	filters?: BasesConfigFileFilter;
	groupBy?: { property?: string; direction?: string } | string;
	groupOrder?: unknown[];
	order?: string[];
	summaries?: Record<string, string>;
	sort?: { property?: string; direction?: string }[];
	limit?: number;
	[key: string]: unknown;
}

export interface BasesConfigFile {
	filters?: BasesConfigFileFilter;
	properties?: Record<string, Record<string, any>>;
	formulas?: Record<string, string>;
	summaries?: Record<string, string>;
	views?: BasesConfigFileView[];
}

export interface BasesSortConfig {
	property: BasesPropertyId;
	direction: "ASC" | "DESC";
}

export interface BasesGroupBy {
	property: BasesPropertyId;
	direction: "ASC" | "DESC";
}

// A parsed .base file. A base with no views shows one table; it is written to
// the file only once something about it changes.
export class BaseDocument {
	text: string;
	config: BasesConfigFile = {};
	views: BasesConfigFileView[] = [];
	error: string | null = null;
	#doc: YAML.Document;
	// The position of each view in the YAML list, which may hold entries that
	// are not views; null for the implicit view.
	#indexes: (number | null)[] = [];

	constructor(text: string) {
		this.text = text;
		this.#doc = YAML.parseDocument(text);
		const problem = this.#doc.errors[0];
		if (problem) {
			this.error = `Invalid YAML: ${problem.message.split("\n")[0]}`;
			return;
		}
		const data = this.#doc.toJS();
		if (data !== null && data !== undefined && (typeof data !== "object" || Array.isArray(data))) {
			this.error = "A base must be a YAML mapping of filters, formulas, properties and views.";
			return;
		}
		this.config = data ?? {};
		const listed: unknown[] = Array.isArray(this.config.views) ? this.config.views : [];
		listed.forEach((view, i) => {
			if (!view || typeof view !== "object" || Array.isArray(view)) return;
			const v = view as BasesConfigFileView;
			if (typeof v.type !== "string" || !v.type) v.type = "table";
			if (typeof v.name !== "string") v.name = v.name === undefined || v.name === null ? defaultViewName(v.type) : String(v.name);
			this.views.push(v);
			this.#indexes.push(i);
		});
		if (this.views.length === 0) {
			this.views.push({ type: "table", name: defaultViewName("table") });
			this.#indexes.push(null);
		}
		this.config.views = this.views;
	}

	// Write one key of one view, or delete it with undefined, and return the new text.
	setViewKey(index: number, key: string, value: unknown) {
		const at = this.#docIndex(index);
		if (value === undefined) this.#doc.deleteIn(["views", at, key]);
		else this.#doc.setIn(["views", at, key], this.#doc.createNode(value));
		return this.#commit();
	}

	addView(view: BasesConfigFileView) {
		this.views.push(view);
		this.#indexes.push(null);
		this.#docIndex(this.views.length - 1);
		return this.#commit();
	}

	removeView(index: number) {
		const at = this.#docIndex(index);
		this.#doc.deleteIn(["views", at]);
		this.views.splice(index, 1);
		this.#indexes.splice(index, 1);
		this.#indexes = this.#indexes.map((i) => (i !== null && i > at ? i - 1 : i));
		return this.#commit();
	}

	// The view's index in the YAML list, adding it (and the list) when it is
	// not written yet.
	#docIndex(index: number): number {
		const known = this.#indexes[index];
		if (known !== null && known !== undefined) return known;
		if (!YAML.isMap(this.#doc.contents)) this.#doc.contents = this.#doc.createNode({}) as any;
		let seq = this.#doc.get("views");
		if (!YAML.isSeq(seq)) {
			seq = this.#doc.createNode([]);
			this.#doc.set("views", seq);
		}
		const items = (seq as YAML.YAMLSeq).items;
		items.push(this.#doc.createNode(this.views[index]) as any);
		this.#indexes[index] = items.length - 1;
		return items.length - 1;
	}

	#commit() {
		this.text = this.#doc.toString();
		return this.text;
	}
}

export function defaultViewName(type: string) {
	return type.charAt(0).toUpperCase() + type.slice(1);
}

export interface ViewConfigHooks {
	// A key of the view changed through set(); persist it and rerun the query.
	changed(config: BasesViewConfig, key: string, value: unknown): void;
	// Evaluate a formula against `this` for getEvaluatedFormula.
	evaluate(formula: string, view: unknown): Value;
}

const raw = new WeakMap<BasesViewConfig, BasesConfigFileView>();

// The view entry behind a config, for the query engine.
export function viewData(config: BasesViewConfig): BasesConfigFileView {
	return raw.get(config) ?? { type: "table", name: "" };
}

function clone<T>(value: T): T {
	try {
		return structuredClone(value);
	} catch {
		return value;
	}
}

// One entry of a base's `views` list, as plugin views see it.
export class BasesViewConfig {
	#file: BasesConfigFile;
	#hooks: ViewConfigHooks | null;

	constructor(view: BasesConfigFileView = { type: "table", name: "" }, file: BasesConfigFile = {}, hooks: ViewConfigHooks | null = null) {
		raw.set(this, view);
		this.#file = file;
		this.#hooks = hooks;
	}

	get name(): string {
		return viewData(this).name;
	}

	set name(name: string) {
		this.set("name", name);
	}

	get(key: string): unknown {
		return viewData(this)[key];
	}

	getAsPropertyId(key: string): BasesPropertyId | null {
		return normalizePropertyId(viewData(this)[key]);
	}

	getEvaluatedFormula(view: unknown, key: string): Value {
		const formula = viewData(this)[key];
		if (typeof formula !== "string" || !formula.trim() || !this.#hooks) return NullValue.value;
		const value = this.#hooks.evaluate(formula, view);
		return value instanceof ErrorValue ? NullValue.value : value;
	}

	set(key: string, value: any | null) {
		const view = viewData(this);
		const next = value === null || value === undefined ? undefined : clone(value);
		if (JSON.stringify(view[key]) === JSON.stringify(next)) return;
		if (next === undefined) delete view[key];
		else view[key] = next;
		this.#hooks?.changed(this, key, next);
	}

	getOrder(): BasesPropertyId[] {
		const order = viewData(this).order;
		const ids = (Array.isArray(order) ? order : []).map(normalizePropertyId).filter((id): id is BasesPropertyId => id !== null);
		return [...new Set(ids)];
	}

	// Entries without a property or with a direction other than ASC/DESC are dropped.
	getSort(): BasesSortConfig[] {
		const sort = viewData(this).sort;
		return (Array.isArray(sort) ? sort : []).flatMap((s) => {
			const property = normalizePropertyId(s?.property);
			const direction = String(s?.direction ?? "ASC").toUpperCase();
			return property && (direction === "ASC" || direction === "DESC") ? [{ property, direction }] : [];
		});
	}

	getDisplayName(propertyId: BasesPropertyId): string {
		const id = normalizePropertyId(propertyId) ?? propertyId;
		for (const [key, settings] of Object.entries(this.#file.properties ?? {})) {
			const name = settings?.displayName;
			if (normalizePropertyId(key) === id && typeof name === "string" && name.trim()) return name;
		}
		const { type, name } = parsePropertyId(id);
		return type === "file" ? (FILE_PROPERTIES[name] ?? name) : name;
	}
}

export function groupByOf(config: BasesViewConfig): BasesGroupBy | null {
	const groupBy = viewData(config).groupBy;
	const spec = typeof groupBy === "string" ? { property: groupBy } : groupBy;
	const property = normalizePropertyId(spec?.property);
	if (!property) return null;
	return { property, direction: String(spec?.direction ?? "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC" };
}

export function limitOf(config: BasesViewConfig): number | null {
	const limit = Number(viewData(config).limit);
	return Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
}

// The view's summaries by property id.
export function summariesOf(config: BasesViewConfig): Map<BasesPropertyId, string> {
	const out = new Map<BasesPropertyId, string>();
	const summaries = viewData(config).summaries;
	for (const [key, name] of Object.entries(summaries && typeof summaries === "object" ? summaries : {})) {
		const id = normalizePropertyId(key);
		if (id && typeof name === "string" && name) out.set(id, name);
	}
	return out;
}
