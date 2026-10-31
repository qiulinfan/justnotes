// Running a base: filter every vault file, sort, limit, group and summarize.
import type { TFile } from "../vault";
import { compareValues, groupKey, isEmptyValue, sortCompare, toDate, toNumber } from "./compare";
import { type BasesConfigFile, type BasesViewConfig, groupByOf, limitOf, viewData } from "./config";
import { BasesEntry, BasesEntryGroup, type QueryRun } from "./entry";
import { parseExpression } from "./expression";
import { inferValue } from "./frontmatter";
import { type BasesPropertyId, FILE_PROPERTIES } from "./property";
import { BooleanValue, DateValue, DurationValue, ErrorValue, ListValue, NullValue, NumberValue, Value } from "./values";

// What a query's filters ran into: messages for the user, and for each filter
// formula whether any entry passed it and the first error it gave.
export class FilterLog {
	errors = new Set<string>();
	#outcomes = new Map<string, { passed: boolean; error: string | null }>();

	record(src: string, value: Value) {
		let outcome = this.#outcomes.get(src);
		if (!outcome) this.#outcomes.set(src, (outcome = { passed: false, error: null }));
		if (value instanceof ErrorValue) outcome.error ??= value.message;
		else if (value.isTruthy()) outcome.passed = true;
	}

	// A formula that gave errors and let no entry through is broken rather than
	// strict, such as a misspelt function, so the empty result is explained.
	// One that errs only on some entries, as `date(due)` does where due is
	// empty, is working.
	messages(): string[] {
		const out = new Set(this.errors);
		for (const [src, { passed, error }] of this.#outcomes) if (error && !passed) out.add(`Filter "${src}": ${error}`);
		return [...out];
	}
}

// A filter is a formula string or an and/or/not list of filters. A formula
// that does not parse matches nothing and is reported once; an error while
// evaluating one is false for that entry.
export function testFilter(filter: unknown, run: QueryRun, entry: BasesEntry, log: FilterLog): boolean {
	if (filter === null || filter === undefined) return true;
	if (typeof filter === "boolean") return filter;
	if (typeof filter === "string" || typeof filter === "number") {
		const src = String(filter);
		const parsed = parseExpression(src);
		if (!parsed.node) {
			log.errors.add(`Filter "${src}": ${parsed.error}`);
			return false;
		}
		const value = run.evaluate(src, entry);
		log.record(src, value);
		return value.isTruthy();
	}
	if (Array.isArray(filter)) return filter.every((f) => testFilter(f, run, entry, log));
	if (typeof filter === "object") {
		const f = filter as Record<string, unknown>;
		const list = (v: unknown) => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
		if ("and" in f) return list(f.and).every((x) => testFilter(x, run, entry, log));
		if ("or" in f) {
			const any = list(f.or);
			return any.length === 0 || any.some((x) => testFilter(x, run, entry, log));
		}
		if ("not" in f) return !list(f.not).some((x) => testFilter(x, run, entry, log));
	}
	log.errors.add(`Unrecognised filter: ${JSON.stringify(filter)}`);
	return false;
}

export interface QueryOutput {
	result: BasesQueryResult;
	// Properties found in the matching files, then formulas, then file properties.
	allProperties: BasesPropertyId[];
	errors: string[];
}

// The toolbar's search: entries whose file name or any visible property
// contains the text, ignoring case.
function matchesSearch(entry: BasesEntry, columns: BasesPropertyId[], search: string) {
	if (entry.file.name.toLowerCase().includes(search)) return true;
	return columns.some((id) => entry.getValue(id)?.toString().toLowerCase().includes(search));
}

export function executeQuery(run: QueryRun, config: BasesConfigFile, view: BasesViewConfig, files: TFile[], search = ""): QueryOutput {
	const log = new FilterLog();
	const filters = viewData(view).filters;
	const matching: BasesEntry[] = [];
	for (const file of files) {
		const entry = new BasesEntry(run, file);
		if (testFilter(config.filters, run, entry, log) && testFilter(filters, run, entry, log)) matching.push(entry);
	}
	const query = search.trim().toLowerCase();
	const columns = view.getOrder();
	const found = query ? matching.filter((entry) => matchesSearch(entry, columns, query)) : matching;
	const sorts = view.getSort();
	const keyed = found.map((entry) => ({ entry, keys: sorts.map((s) => entry.getValue(s.property)) }));
	keyed.sort((a, b) => {
		for (let i = 0; i < sorts.length; i++) {
			const c = sortCompare(a.keys[i], b.keys[i], sorts[i].direction);
			if (c) return c;
		}
		return a.entry.file.path < b.entry.file.path ? -1 : a.entry.file.path > b.entry.file.path ? 1 : 0;
	});
	const limit = limitOf(view);
	const data = keyed.slice(0, limit ?? keyed.length).map((k) => k.entry);
	return { result: new BasesQueryResult(data, run, config, view), allProperties: collectProperties(matching, run), errors: log.messages() };
}

function collectProperties(entries: BasesEntry[], run: QueryRun): BasesPropertyId[] {
	const notes = new Set<string>();
	for (const entry of entries) for (const key of Object.keys(entry.frontmatter() ?? {})) notes.add(key);
	return [
		...[...notes].sort((a, b) => a.localeCompare(b)).map((k): BasesPropertyId => `note.${k}`),
		...Object.keys(run.formulas).map((k): BasesPropertyId => `formula.${k}`),
		...Object.keys(FILE_PROPERTIES).map((k): BasesPropertyId => `file.${k}`),
	];
}

function groupEntries(data: BasesEntry[], run: QueryRun | null, view: BasesViewConfig | null): BasesEntryGroup[] {
	const groupBy = view ? groupByOf(view) : null;
	if (!groupBy) return [new BasesEntryGroup(undefined, data)];
	const groups = new Map<string, BasesEntryGroup>();
	for (const entry of data) {
		const key = entry.getValue(groupBy.property) ?? NullValue.value;
		const id = groupKey(key);
		const group = groups.get(id);
		if (group) group.entries.push(entry);
		else groups.set(id, new BasesEntryGroup(key, [entry]));
	}
	const sorted = [...groups.values()].sort((a, b) => sortCompare(a.key ?? null, b.key ?? null, groupBy.direction));
	// groupOrder picks the groups to show and their order; null is the group
	// without a value, and a listed value with no entries is an empty group.
	const order = viewData(view!).groupOrder;
	if (!Array.isArray(order) || !run) return sorted;
	const shown: BasesEntryGroup[] = [];
	for (const raw of order) {
		const want = raw === null ? NullValue.value : inferValue(run.app, raw, run.sourcePath);
		const group = sorted.find((g) => !shown.includes(g) && Value.looseEquals(g.key ?? NullValue.value, want));
		shown.push(group ?? new BasesEntryGroup(want, []));
	}
	return shown;
}

// The built-in summaries, by the names a view's `summaries` uses.
const SUMMARIES: Record<string, (values: Value[]) => Value> = {
	average: (vs) => numeric(vs, (ns) => ns.reduce((a, b) => a + b, 0) / ns.length),
	min: (vs) => numeric(vs, (ns) => Math.min(...ns)),
	max: (vs) => numeric(vs, (ns) => Math.max(...ns)),
	sum: (vs) => numeric(vs, (ns) => ns.reduce((a, b) => a + b, 0)),
	median: (vs) =>
		numeric(vs, (ns) => {
			const s = [...ns].sort((a, b) => a - b);
			const mid = s.length >> 1;
			return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
		}),
	stddev: (vs) =>
		numeric(vs, (ns) => {
			const mean = ns.reduce((a, b) => a + b, 0) / ns.length;
			return Math.sqrt(ns.reduce((a, b) => a + (b - mean) ** 2, 0) / ns.length);
		}),
	range: (vs) => {
		const dates = datesOf(vs);
		if (dates.length) return DurationValue.fromMilliseconds(Math.max(...dates) - Math.min(...dates));
		return numeric(vs, (ns) => Math.max(...ns) - Math.min(...ns));
	},
	earliest: (vs) => extremeDate(vs, -1),
	latest: (vs) => extremeDate(vs, 1),
	checked: (vs) => new NumberValue(vs.filter((v) => v instanceof BooleanValue && v.value).length),
	// A checkbox that was never set shows unchecked, so it counts as one.
	unchecked: (vs) => new NumberValue(vs.filter((v) => (v instanceof BooleanValue && !v.value) || v instanceof NullValue).length),
	empty: (vs) => new NumberValue(vs.filter(isEmptyValue).length),
	filled: (vs) => new NumberValue(vs.filter((v) => !isEmptyValue(v)).length),
	unique: (vs) => new NumberValue(new Set(vs.filter((v) => !isEmptyValue(v)).map(groupKey)).size),
};

export const BUILT_IN_SUMMARIES = ["Average", "Min", "Max", "Sum", "Range", "Median", "Stddev", "Earliest", "Latest", "Checked", "Unchecked", "Empty", "Filled", "Unique"];

function numeric(values: Value[], fn: (ns: number[]) => number): Value {
	const ns = values.map(toNumber).filter((n): n is number => n !== null);
	return ns.length ? new NumberValue(fn(ns)) : NullValue.value;
}

function datesOf(values: Value[]) {
	return values.map((v) => toDate(v)?.date.getTime()).filter((t): t is number => t !== undefined && !Number.isNaN(t));
}

function extremeDate(values: Value[], pick: 1 | -1): Value {
	let best: DateValue | null = null;
	for (const v of values) {
		const d = toDate(v);
		if (d && (!best || (compareValues(d, best) ?? 0) * pick > 0)) best = d;
	}
	return best ?? NullValue.value;
}

// The result of running a base's query for one view. It is rebuilt on every
// change, and so are its entries.
export class BasesQueryResult {
	data: BasesEntry[];
	#run: QueryRun | null;
	#config: BasesConfigFile;
	#view: BasesViewConfig | null;
	#grouped: BasesEntryGroup[] | null = null;

	constructor(data: BasesEntry[] = [], run: QueryRun | null = null, config: BasesConfigFile = {}, view: BasesViewConfig | null = null) {
		this.data = data;
		this.#run = run;
		this.#config = config;
		this.#view = view;
	}

	get groupedData(): BasesEntryGroup[] {
		this.#grouped ??= groupEntries(this.data, this.#run, this.#view);
		return this.#grouped;
	}

	get properties(): BasesPropertyId[] {
		return this.#view?.getOrder() ?? [];
	}

	// A built-in summary by name (any case), or a formula from the base's
	// `summaries` with `values` bound to the property's values.
	getSummaryValue(_queryController: unknown, entries: BasesEntry[], prop: BasesPropertyId, summaryKey: string): Value {
		const values = entries.map((e) => e.getValue(prop) ?? NullValue.value);
		const builtIn = SUMMARIES[summaryKey.toLowerCase()];
		const formula = this.#config.summaries?.[summaryKey];
		if (typeof formula === "string" && this.#run) return this.#run.evaluate(formula, null, { values: new ListValue(values) });
		if (builtIn) return builtIn(values);
		return new ErrorValue(`Unknown summary "${summaryKey}"`);
	}
}
