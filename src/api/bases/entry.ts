import type { App } from "../app";
import type { TFile } from "../vault";
import { evaluateExpression, type RowContext, type Scope } from "./evaluator";
import { fileField, frontmatterOf } from "./file-fields";
import { wrapProperty } from "./frontmatter";
import { type BasesPropertyId, normalizePropertyId, parsePropertyId } from "./property";
import { ErrorValue, FileValue, NullValue, ObjectValue, type Value } from "./values";

// What every row of one query run shares: the base's formulas and `this`.
export class QueryRun {
	app: App;
	formulas: Record<string, unknown>;
	thisFile: TFile | null;
	// Where formulas resolve links from: the base file or the embedding note.
	sourcePath: string;
	#thisEntry: BasesEntry | null | undefined;

	constructor(app: App, formulas: Record<string, unknown> | undefined, thisFile: TFile | null, sourcePath: string) {
		this.app = app;
		this.formulas = formulas && typeof formulas === "object" ? formulas : {};
		this.thisFile = thisFile;
		this.sourcePath = sourcePath;
	}

	get thisEntry() {
		if (this.#thisEntry === undefined) this.#thisEntry = this.thisFile ? new BasesEntry(this, this.thisFile) : null;
		return this.#thisEntry;
	}

	scope(row: RowContext | null, vars?: Record<string, Value>): Scope {
		return { app: this.app, row, thisRow: this.thisEntry, sourcePath: this.sourcePath, vars };
	}

	evaluate(src: string, row: RowContext | null, vars?: Record<string, Value>) {
		return evaluateExpression(src, this.scope(row, vars));
	}
}

// One row of a base: a vault file. Formulas are evaluated on first use and
// remembered for the life of the entry, which is one query run.
export class BasesEntry implements RowContext {
	file: TFile;
	#run: QueryRun;
	#notes = new Map<string, Value>();
	#formulas = new Map<string, Value>();
	#evaluating = new Set<string>();
	#fileValue: FileValue | null = null;

	constructor(run: QueryRun, file: TFile) {
		this.#run = run;
		this.file = file;
	}

	getValue(propertyId: BasesPropertyId): Value | null {
		const id = normalizePropertyId(propertyId);
		if (!id) return null;
		const { type, name } = parsePropertyId(id);
		if (type === "note") return this.note(name);
		if (type === "formula") return this.formula(name);
		return fileField(this.#run.app, this.file, name) ?? null;
	}

	frontmatter() {
		return frontmatterOf(this.#run.app, this.file);
	}

	// Property names match exactly, then ignoring case, as Obsidian's do.
	note(name: string): Value {
		const cached = this.#notes.get(name);
		if (cached) return cached;
		const fm = this.frontmatter();
		let key: string | undefined = name;
		if (fm && !Object.hasOwn(fm, key)) {
			const lower = name.toLowerCase();
			key = Object.keys(fm).find((k) => k.toLowerCase() === lower);
		}
		const value = fm && key !== undefined ? wrapProperty(this.#run.app, key, fm[key], this.file.path) : NullValue.value;
		this.#notes.set(name, value);
		return value;
	}

	noteObject() {
		return new ObjectValue(this.frontmatter() ?? {}, (key) => this.note(key));
	}

	fileValue() {
		this.#fileValue ??= new FileValue(this.#run.app, this.file);
		return this.#fileValue;
	}

	formula(name: string): Value {
		const cached = this.#formulas.get(name);
		if (cached) return cached;
		const formulas = this.#run.formulas;
		if (!Object.hasOwn(formulas, name) || formulas[name] === null || formulas[name] === undefined) return NullValue.value;
		if (this.#evaluating.has(name)) return new ErrorValue(`Formula "${name}" refers to itself`);
		this.#evaluating.add(name);
		let value: Value;
		try {
			value = this.#run.evaluate(String(formulas[name]), this);
		} finally {
			this.#evaluating.delete(name);
		}
		this.#formulas.set(name, value);
		return value;
	}

	formulaObject() {
		const names = Object.fromEntries(Object.keys(this.#run.formulas).map((k) => [k, null]));
		return new ObjectValue(names, (key) => this.formula(key));
	}
}

// The entries that share one value of the groupBy property. Without groupBy
// the result is one group whose key is undefined.
export class BasesEntryGroup {
	key?: Value;
	entries: BasesEntry[];

	constructor(key: Value | undefined, entries: BasesEntry[] = []) {
		this.key = key;
		this.entries = entries;
	}

	hasKey() {
		return this.key !== undefined && !(this.key instanceof NullValue);
	}
}
