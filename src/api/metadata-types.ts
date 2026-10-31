// app.metadataTypeManager: the property types of the vault. A type is
// assigned per property name, case-insensitively, for every note. The
// assignments are Obsidian's defaults (tags, aliases, cssclasses), then the
// vault's .obsidian/types.json, then the changes made in justnotes, which
// never writes .obsidian and keeps them in localStorage (`property-types`).
import type { App } from "./app";
import { type Component, type EventRef, Events } from "./events";
import { builtInWidgets } from "./metadata-widgets";
import { debounce } from "./util";

export interface PropertyInfo {
	name: string;
	// The assigned type, else the type most of the property's values have.
	type: string;
	widget: string;
	// Notes that have the property.
	count: number;
	occurrences: number;
}

export interface PropertyRenderContext {
	app: App;
	key: string;
	sourcePath: string;
	onChange(value: unknown): void;
	// Leaves the value, focusing its property.
	blur(): void;
	metadataEditor?: unknown;
}

// What a widget's render returns, when it returns anything: a component the
// properties editor unloads with the value, that can take focus.
export interface PropertyWidgetComponent extends Partial<Component> {
	focus?(at?: "start" | "end"): void;
}

export interface PropertyWidget {
	type: string;
	icon: string;
	name(): string;
	validate(value: unknown): boolean;
	render(containerEl: HTMLElement, value: unknown, ctx: PropertyRenderContext): PropertyWidgetComponent | void;
	// Property names the type is for alone (tags, aliases).
	reservedKeys?: string[];
}

export interface TypeInfo {
	expected: PropertyWidget;
	inferred: PropertyWidget;
}

export interface AssignedType {
	name: string;
	type: string;
}

const DEFAULT_TYPES: Record<string, string> = {
	tags: "tags",
	aliases: "aliases",
	cssclasses: "multitext",
	// Obsidian's names before 1.4, still in older notes.
	tag: "tags",
	alias: "aliases",
	cssclass: "multitext",
};

const DATE = /^\d{4}-\d\d-\d\d$/;
const DATETIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/;
const LIST_TYPES = new Set(["multitext", "tags", "aliases"]);

const isEmpty = (v: unknown) => v === null || v === undefined;
const isScalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

export function isListType(type: string) {
	return LIST_TYPES.has(type);
}

// The type a value has without an assigned one.
export function inferType(value: unknown): string {
	if (typeof value === "boolean") return "checkbox";
	if (typeof value === "number") return "number";
	if (Array.isArray(value)) return "multitext";
	if (typeof value === "string") return DATE.test(value) ? "date" : DATETIME.test(value) ? "datetime" : "text";
	if (isEmpty(value)) return "text";
	return "unknown";
}

// Whether a value is one the type's widget shows and edits as it is.
export function validateType(type: string, value: unknown): boolean {
	if (isEmpty(value)) return type !== "unknown";
	switch (type) {
		case "text":
			return typeof value === "string" || typeof value === "number";
		case "multitext":
		case "aliases":
			return Array.isArray(value) ? value.every((v) => isEmpty(v) || isScalar(v)) : typeof value === "string";
		case "tags":
			return Array.isArray(value) ? value.every((v) => isEmpty(v) || isScalar(v)) : typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "checkbox":
			return typeof value === "boolean";
		case "date":
			return typeof value === "string" && DATE.test(value);
		case "datetime":
			return typeof value === "string" && (DATETIME.test(value) || DATE.test(value));
		case "unknown":
			return true;
	}
	return true;
}

// The value a property changed to `type` takes, or undefined when it should
// keep its value (shown as not matching the type) because no conversion
// keeps what it says.
export function convertValue(value: unknown, type: string): unknown {
	const items = Array.isArray(value) ? value.filter((v) => !isEmpty(v)) : [value];
	if (isListType(type) && !Array.isArray(value) && !isEmpty(value)) {
		if (!isScalar(value) || value === "") return value === "" ? null : undefined;
		if (type === "tags" && typeof value === "string") return value.split(/[,\s]+/).filter(Boolean).map((t) => t.replace(/^#/, ""));
		return [String(value)];
	}
	if (isEmpty(value) || validateType(type, value)) return value ?? null;
	if (isListType(type)) return items.every(isScalar) ? items.map(String) : undefined;
	if (items.length !== 1 || !isScalar(items[0])) return items.length === 0 ? null : type === "text" && items.every(isScalar) ? items.join(", ") : undefined;
	const one = items[0];
	const text = String(one).trim();
	switch (type) {
		case "text":
			return String(one);
		case "number": {
			const n = Number(text);
			return text && Number.isFinite(n) ? n : undefined;
		}
		case "checkbox":
			return text === "true" ? true : text === "false" ? false : undefined;
		case "date":
			return DATE.test(text) ? text : DATETIME.test(text) ? text.slice(0, 10) : undefined;
		case "datetime":
			return DATETIME.test(text) ? text : DATE.test(text) ? `${text}T00:00:00` : undefined;
	}
	return undefined;
}

export class MetadataTypeManager extends Events {
	app: App;
	// Every property name in the vault's notes, by lowercased name.
	properties: Record<string, PropertyInfo> = {};
	// The assigned types, by lowercased name.
	types: Record<string, AssignedType> = {};
	registeredTypeWidgets: Record<string, PropertyWidget> = {};
	#fileTypes: Record<string, AssignedType> = {};
	// justnotes' own assignments; an empty type unassigns.
	#overrides: Record<string, AssignedType> = {};
	#refs: EventRef[] = [];
	#refresh = debounce(() => this.updatePropertyInfoCache(), 300, true);
	#reread = debounce(() => this.onConfigFileChange(), 100, true);

	constructor(app: App) {
		super();
		this.app = app;
		const widgets = builtInWidgets();
		for (const widget of widgets) this.registeredTypeWidgets[widget.type] = widget;
		this.#merge();
	}

	// Reads types.json and justnotes' assignments, counts the properties, and
	// follows changes to either and to the notes.
	async load() {
		this.#overrides = this.#readOverrides();
		await this.onConfigFileChange();
		this.updatePropertyInfoCache();
		if (this.#refs.length) return;
		const { vault, metadataCache } = this.app;
		this.#refs.push(
			vault.on("raw", (path: string) => path === this.#typesPath() && this.#reread()),
			metadataCache.on("changed", () => this.#refresh()),
			metadataCache.on("deleted", () => this.#refresh()),
			metadataCache.on("resolved", () => this.#refresh()),
		);
	}

	unload() {
		for (const ref of this.#refs) ref.e.offref(ref);
		this.#refs = [];
		this.#refresh.cancel();
		this.#reread.cancel();
	}

	#typesPath() {
		return `${this.app.vault.configDir}/types.json`;
	}

	#readOverrides(): Record<string, AssignedType> {
		const saved = this.app.loadLocalStorage("property-types");
		const out: Record<string, AssignedType> = {};
		if (!saved || typeof saved !== "object") return out;
		for (const [key, entry] of Object.entries(saved as Record<string, AssignedType>)) {
			if (entry && typeof entry.name === "string" && typeof entry.type === "string") out[key] = { name: entry.name, type: entry.type };
		}
		return out;
	}

	async onConfigFileChange() {
		const types: Record<string, AssignedType> = {};
		try {
			const json = JSON.parse(await this.app.vault.adapter.read(this.#typesPath()));
			for (const [name, type] of Object.entries(json?.types ?? {})) if (typeof type === "string") types[name.toLowerCase()] = { name, type };
		} catch {}
		const before = JSON.stringify(this.types);
		this.#fileTypes = types;
		this.#merge();
		if (JSON.stringify(this.types) !== before) {
			this.updatePropertyInfoCache();
			this.trigger("changed");
		}
	}

	#merge() {
		const types: Record<string, AssignedType> = {};
		for (const [key, type] of Object.entries(DEFAULT_TYPES)) types[key] = { name: key, type };
		Object.assign(types, this.#fileTypes);
		for (const [key, entry] of Object.entries(this.#overrides)) {
			if (entry.type) types[key] = entry;
			else delete types[key];
		}
		this.types = types;
	}

	// Recounts the properties of every note in the metadata cache.
	updatePropertyInfoCache() {
		const tally = new Map<string, { name: string; count: number; types: Map<string, number> }>();
		const cache = this.app.metadataCache;
		for (const path of cache.getCachedFiles()) {
			const fm = cache.getCache(path)?.frontmatter;
			if (!fm || typeof fm !== "object") continue;
			for (const [name, value] of Object.entries(fm)) {
				const key = name.toLowerCase();
				let entry = tally.get(key);
				if (!entry) tally.set(key, (entry = { name, count: 0, types: new Map() }));
				entry.count++;
				if (!isEmpty(value)) {
					const type = inferType(value);
					entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
				}
			}
		}
		const properties: Record<string, PropertyInfo> = {};
		for (const [key, { name, count, types }] of tally) {
			let type = this.types[key]?.type;
			if (!type) {
				let best = 0;
				for (const [t, n] of types) if (n > best) [type, best] = [t, n];
			}
			type ??= "text";
			properties[key] = { name, type, widget: type, count, occurrences: count };
		}
		this.properties = properties;
	}

	getPropertyInfo(name: string): PropertyInfo | undefined {
		return this.properties[name.toLowerCase()];
	}

	getAllProperties() {
		return this.properties;
	}

	getAssignedType(name: string): string | null {
		return this.types[name.toLowerCase()]?.type ?? null;
	}

	getWidget(type: string): PropertyWidget {
		return this.registeredTypeWidgets[type] ?? this.registeredTypeWidgets.text;
	}

	// The widget a property is expected to have (its assigned type, else the
	// type its values usually have) and the one `value` has by itself. Without
	// a value both come from the property's values across the vault.
	getTypeInfo(name: string, value?: unknown): TypeInfo {
		const info = this.getPropertyInfo(name);
		const inferredType = value === undefined ? (info?.type ?? "text") : inferType(value);
		const inferred = this.getWidget(inferredType);
		const assigned = this.getAssignedType(name);
		const expectedType = assigned && this.registeredTypeWidgets[assigned] ? assigned : value === undefined ? inferredType : (info?.type ?? inferredType);
		return { expected: this.getWidget(expectedType), inferred };
	}

	// The types a property can be given: every widget but those reserved for
	// other names, and never "unknown".
	getTypesFor(name: string): PropertyWidget[] {
		const key = name.toLowerCase();
		return Object.values(this.registeredTypeWidgets).filter((w) => w.type !== "unknown" && (!w.reservedKeys || w.reservedKeys.includes(key)));
	}

	setType(name: string, type: string) {
		const key = name.toLowerCase();
		if (this.types[key]?.type === type) return;
		this.#overrides[key] = { name, type };
		this.#apply(name);
	}

	unsetType(name: string) {
		const key = name.toLowerCase();
		if (!this.types[key]) return;
		this.#overrides[key] = { name, type: "" };
		this.#apply(name);
	}

	#apply(name: string) {
		this.save();
		this.#merge();
		this.updatePropertyInfoCache();
		this.trigger("changed", name);
	}

	// justnotes' assignments, the only thing a type change writes.
	save() {
		this.app.saveLocalStorage("property-types", Object.keys(this.#overrides).length ? this.#overrides : null);
	}
}
