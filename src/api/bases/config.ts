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

// YAML's empty value, which a key or a file holds before anything is written.
const isEmptyNode = (node: unknown) => node === null || node === undefined || (YAML.isScalar(node) && (node.value === null || node.value === undefined));

// A parsed .base file. A base with no views shows one table; it is written to
// the file only once something about it changes. A base with an error is
// never written: the edit methods throw instead.
export class BaseDocument {
	text: string;
	config: BasesConfigFile = {};
	views: BasesConfigFileView[] = [];
	error: string | null = null;
	#doc: YAML.Document;
	// The position of each view in the YAML list, which may hold entries that
	// are not views; null for a view not written yet, such as the implicit one.
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
		const views = this.#doc.get("views", true);
		if (!isEmptyNode(views) && !YAML.isSeq(views)) {
			this.error = "`views` must be a list of views.";
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
		this.#check();
		const at = this.#docIndex(index);
		if (value === undefined) this.#doc.deleteIn(["views", at, key]);
		else this.#doc.setIn(["views", at, key], this.#doc.createNode(value));
		return this.#commit();
	}

	// Write a key outside `views`, such as ["formulas", "total"], in both the
	// YAML and the parsed config; undefined deletes it.
	setIn(path: string[], value: unknown) {
		this.#check();
		const last = path[path.length - 1];
		if (value === undefined) {
			if (this.#doc.hasIn(path)) this.#doc.deleteIn(path);
		} else this.#mapAt(path.slice(0, -1)).set(last, this.#doc.createNode(value));
		let target: Record<string, any> = this.config;
		for (const key of path.slice(0, -1)) {
			if (!target[key] || typeof target[key] !== "object") {
				if (value === undefined) return this.#commit();
				target[key] = {};
			}
			target = target[key];
		}
		if (value === undefined) delete target[last];
		else target[last] = value;
		return this.#commit();
	}

	addView(view: BasesConfigFileView) {
		this.#check();
		this.views.push(view);
		this.#indexes.push(null);
		this.#docIndex(this.views.length - 1);
		return this.#commit();
	}

	removeView(index: number) {
		this.#check();
		const at = this.#docIndex(index);
		this.#doc.deleteIn(["views", at]);
		this.views.splice(index, 1);
		this.#indexes.splice(index, 1);
		this.#indexes = this.#indexes.map((i) => (i !== null && i > at ? i - 1 : i));
		return this.#commit();
	}

	#check() {
		if (this.error) throw new Error(this.error);
	}

	// The mapping at `path`, made where a key is missing or empty. A key that
	// holds anything else is never replaced.
	#mapAt(path: string[]): YAML.YAMLMap {
		if (isEmptyNode(this.#doc.contents)) this.#doc.contents = this.#doc.createNode({});
		let map = this.#doc.contents as YAML.YAMLMap;
		path.forEach((key, i) => {
			const node: unknown = map.get(key, true);
			if (YAML.isMap(node)) map = node;
			else if (isEmptyNode(node)) {
				const next = this.#doc.createNode({}) as YAML.YAMLMap;
				map.set(key, next);
				map = next;
			} else throw new Error(`"${path.slice(0, i + 1).join(".")}" in the base is not a mapping`);
		});
		return map;
	}

	// The view's index in the YAML list. A view not written yet is added at the
	// end, after any earlier view that is not written either, so the file lists
	// the views in the order the toolbar shows.
	#docIndex(index: number): number {
		const known = this.#indexes[index];
		if (known !== null && known !== undefined) return known;
		for (let i = 0; i < index; i++) this.#docIndex(i);
		const root = this.#mapAt([]);
		let seq: unknown = root.get("views", true);
		if (!YAML.isSeq(seq)) {
			seq = this.#doc.createNode([]);
			root.set("views", seq);
		}
		const items = (seq as YAML.YAMLSeq).items;
		items.push(this.#doc.createNode(this.views[index]) as any);
		this.#indexes[index] = items.length - 1;
		return items.length - 1;
	}

	// Long formulas stay on one line, and flow lists keep their compact form.
	#commit() {
		this.text = this.#doc.toString({ lineWidth: 0, flowCollectionPadding: false });
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
