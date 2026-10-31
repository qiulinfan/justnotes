// Global functions, per-type methods and fields of the formula language, as
// listed in Obsidian's Bases function reference.
import moment from "moment";
import { getLinkpath } from "../metadata-utils";
import type { TFile } from "../vault";
import { compareValues, groupKey, isEmptyValue, sortCompare, toDuration, toNumber, typeName } from "./compare";
import type { Scope } from "./evaluator";
import type { Node } from "./expression";
import { fileField, fileHasTag, fileInFolder, fileLinksTo, frontmatterOf } from "./file-fields";
import {
	BooleanValue,
	DateValue,
	DurationValue,
	ErrorValue,
	FileValue,
	HTMLValue,
	IconValue,
	ImageValue,
	LinkValue,
	ListValue,
	NullValue,
	NumberValue,
	ObjectValue,
	RegExpValue,
	StringValue,
	UrlValue,
	type Value,
	valueTypes,
} from "./values";

export interface CallEnv {
	scope: Scope;
	// Evaluate an argument, optionally with extra bound variables (value, index, acc).
	evaluate(node: Node, vars?: Record<string, Value>): Value;
}

type Fn = (env: CallEnv, args: Node[]) => Value;
type Method<T extends Value> = (env: CallEnv, target: T, args: Node[]) => Value;

// Most functions take evaluated arguments, and an error in one is the result.
function eager(fn: (env: CallEnv, args: Value[]) => Value): Fn {
	return (env, nodes) => {
		const args = nodes.map((n) => env.evaluate(n));
		return args.find((a) => a instanceof ErrorValue) ?? fn(env, args);
	};
}

function method<T extends Value>(fn: (env: CallEnv, target: T, args: Value[]) => Value): Method<T> {
	return (env, target, nodes) => {
		const args = nodes.map((n) => env.evaluate(n));
		return args.find((a) => a instanceof ErrorValue) ?? fn(env, target, args);
	};
}

const bool = (b: boolean) => new BooleanValue(b);
const str = (s: string) => new StringValue(s);
const num = (n: number) => new NumberValue(n);
const own = <T>(table: Record<string, T>, name: string) => (Object.hasOwn(table, name) ? table[name] : undefined);

function needs(name: string, args: unknown[], min: number, max = min) {
	if (args.length >= min && args.length <= max) return null;
	const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
	return new ErrorValue(`${name}() takes ${want} argument${want === "1" ? "" : "s"}`);
}

function numberArg(name: string, value: Value | undefined): number | ErrorValue {
	const n = value ? toNumber(value) : null;
	return n === null ? new ErrorValue(`${name}() needs a number`) : n;
}

// The file a value refers to: a file, a link, `this`, or a path or link text.
export function toFile(env: CallEnv, value: Value): TFile | null {
	const { app, sourcePath } = env.scope;
	if (value instanceof FileValue) return value.file;
	if (value instanceof LinkValue) return value.resolve();
	if (value instanceof StringValue) {
		const link = LinkValue.parseFromString(app, value.value, sourcePath);
		if (link) return link.resolve();
		return app.vault.getFileByPath(value.value) ?? (value.value ? app.metadataCache.getFirstLinkpathDest(getLinkpath(value.value), sourcePath) : null);
	}
	return null;
}

function linkTo(env: CallEnv, target: Value, display: Value | undefined): Value {
	const { app, sourcePath } = env.scope;
	const text = display && !(display instanceof NullValue) ? display.toString() : null;
	if (target instanceof FileValue) return new LinkValue(app, app.metadataCache.fileToLinktext(target.file, sourcePath, true), sourcePath, text);
	if (target instanceof UrlValue) return new UrlValue(target.value, text ?? target.display);
	if (target instanceof LinkValue) return text ? new LinkValue(app, target.link, target.sourcePath, text) : target;
	if (target instanceof StringValue) {
		const s = target.value.trim();
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return new UrlValue(s, text);
		const parsed = LinkValue.parseFromString(app, s, sourcePath);
		if (parsed) return text ? new LinkValue(app, parsed.link, sourcePath, text) : parsed;
		return new LinkValue(app, s, sourcePath, text);
	}
	return new ErrorValue(`link() cannot link to ${typeName(target)}`);
}

// Numbers among the arguments, flattening lists; null when one is not a number.
function numbers(values: Value[]): number[] | null {
	const out: number[] = [];
	for (const v of values.flatMap((v) => (v instanceof ListValue ? v.items : [v]))) {
		if (v instanceof NullValue) continue;
		const n = toNumber(v);
		if (n === null) return null;
		out.push(n);
	}
	return out;
}

function extreme(name: string, values: Value[], pick: 1 | -1): Value {
	const flat = values.flatMap((v) => (v instanceof ListValue ? v.items : [v])).filter((v) => !(v instanceof NullValue));
	if (flat.some((v) => v instanceof DateValue)) {
		let best: Value | null = null;
		for (const v of flat) if (!best || (compareValues(v, best) ?? 0) * pick > 0) best = v;
		return best ?? NullValue.value;
	}
	const ns = numbers(flat);
	if (!ns) return new ErrorValue(`${name}() needs numbers`);
	return ns.length ? num(pick > 0 ? Math.max(...ns) : Math.min(...ns)) : NullValue.value;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

const GLOBALS: Record<string, Fn> = {
	date: eager((_env, args) => {
		const bad = needs("date", args, 1);
		if (bad) return bad;
		const [input] = args;
		if (input instanceof DateValue) return input;
		if (input instanceof NumberValue) return new DateValue(new Date(input.value));
		const parsed = input instanceof StringValue ? DateValue.parseFromString(input.value) : null;
		return parsed ?? new ErrorValue(`date() cannot parse ${input instanceof NullValue ? "an empty value" : `"${input.toString()}"`}`);
	}),
	duration: eager((_env, args) => {
		const bad = needs("duration", args, 1);
		if (bad) return bad;
		return toDuration(args[0]) ?? new ErrorValue(`duration() cannot parse "${args[0].toString()}"`);
	}),
	now: eager((_env, args) => needs("now", args, 0) ?? new DateValue(new Date(), true)),
	today: eager((_env, args) => needs("today", args, 0) ?? new DateValue(moment().startOf("day").toDate(), false)),
	if: (env, nodes) => {
		const bad = needs("if", nodes, 2, 3);
		if (bad) return bad;
		const cond = env.evaluate(nodes[0]);
		if (cond instanceof ErrorValue) return cond;
		if (cond.isTruthy()) return env.evaluate(nodes[1]);
		return nodes[2] ? env.evaluate(nodes[2]) : NullValue.value;
	},
	link: eager((env, args) => needs("link", args, 1, 2) ?? linkTo(env, args[0], args[1])),
	list: eager((_env, args) => {
		const bad = needs("list", args, 1);
		if (bad) return bad;
		const [v] = args;
		return v instanceof ListValue ? v : new ListValue(v instanceof NullValue ? [] : [v]);
	}),
	number: eager((_env, args) => {
		const bad = needs("number", args, 1);
		if (bad) return bad;
		const [v] = args;
		if (v instanceof NullValue) return v;
		if (v instanceof DateValue) return num(v.date.getTime());
		if (v instanceof DurationValue) return num(v.getMilliseconds());
		const n = toNumber(v);
		return n === null ? new ErrorValue(`number() cannot convert "${v.toString()}"`) : num(n);
	}),
	max: eager((_env, args) => extreme("max", args, 1)),
	min: eager((_env, args) => extreme("min", args, -1)),
	file: eager((env, args) => {
		const bad = needs("file", args, 1);
		if (bad) return bad;
		const file = toFile(env, args[0]);
		return file ? new FileValue(env.scope.app, file) : NullValue.value;
	}),
	image: eager((env, args) => {
		const bad = needs("image", args, 1);
		if (bad) return bad;
		const [v] = args;
		const { app, sourcePath } = env.scope;
		if (v instanceof FileValue) return new ImageValue(v.file.path, app, sourcePath);
		if (v instanceof LinkValue) return new ImageValue(v.link, app, v.sourcePath);
		return v instanceof NullValue ? v : new ImageValue(v.toString(), app, sourcePath);
	}),
	icon: eager((_env, args) => needs("icon", args, 1) ?? new IconValue(args[0].toString())),
	html: eager((_env, args) => needs("html", args, 1) ?? new HTMLValue(args[0].toString())),
	escapeHTML: eager((_env, args) => needs("escapeHTML", args, 1) ?? str(args[0].toString().replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]))),
	random: eager((_env, args) => needs("random", args, 0) ?? num(Math.random())),
};

export function callGlobal(env: CallEnv, name: string, args: Node[]): Value {
	const fn = own(GLOBALS, name);
	return fn ? fn(env, args) : new ErrorValue(`Unknown function "${name}"`);
}

const ANY: Record<string, Method<Value>> = {
	isTruthy: method((_env, v, args) => needs("isTruthy", args, 0) ?? bool(v.isTruthy())),
	isType: method((_env, v, args) => needs("isType", args, 1) ?? bool(valueTypes(v).includes(args[0].toString().toLowerCase()))),
	toString: method((_env, v, args) => needs("toString", args, 0) ?? str(v.toString())),
	isEmpty: method((_env, v, args) => needs("isEmpty", args, 0) ?? bool(isEmptyValue(v))),
};

const STRING: Record<string, Method<StringValue>> = {
	contains: method((_env, v, args) => needs("contains", args, 1) ?? bool(v.value.includes(args[0].toString()))),
	containsAll: method((_env, v, args) => needs("containsAll", args, 1, Infinity) ?? bool(args.every((a) => v.value.includes(a.toString())))),
	containsAny: method((_env, v, args) => needs("containsAny", args, 1, Infinity) ?? bool(args.some((a) => v.value.includes(a.toString())))),
	startsWith: method((_env, v, args) => needs("startsWith", args, 1) ?? bool(v.value.startsWith(args[0].toString()))),
	endsWith: method((_env, v, args) => needs("endsWith", args, 1) ?? bool(v.value.endsWith(args[0].toString()))),
	isEmpty: method((_env, v, args) => needs("isEmpty", args, 0) ?? bool(v.value === "")),
	lower: method((_env, v, args) => needs("lower", args, 0) ?? str(v.value.toLowerCase())),
	replace: method((_env, v, args) => {
		const bad = needs("replace", args, 2);
		if (bad) return bad;
		const [pattern, replacement] = args;
		if (pattern instanceof RegExpValue) return str(v.value.replace(new RegExp(pattern.regexp.source, pattern.regexp.flags), replacement.toString()));
		return str(v.value.replaceAll(pattern.toString(), replacement.toString()));
	}),
	repeat: method((_env, v, args) => {
		const n = numberArg("repeat", args[0]);
		if (n instanceof ErrorValue) return n;
		return n >= 0 && v.value.length * n < 1e6 ? str(v.value.repeat(Math.floor(n))) : new ErrorValue("repeat() count out of range");
	}),
	reverse: method((_env, v, args) => needs("reverse", args, 0) ?? str([...v.value].reverse().join(""))),
	slice: method((_env, v, args) => {
		const bad = needs("slice", args, 1, 2);
		if (bad) return bad;
		const start = numberArg("slice", args[0]);
		const end = args[1] ? numberArg("slice", args[1]) : undefined;
		if (start instanceof ErrorValue) return start;
		if (end instanceof ErrorValue) return end;
		return str(v.value.slice(start, end));
	}),
	split: method((_env, v, args) => {
		const bad = needs("split", args, 1, 2);
		if (bad) return bad;
		const [sep, limit] = args;
		const parts = sep instanceof RegExpValue ? v.value.split(new RegExp(sep.regexp.source, sep.regexp.flags)) : v.value.split(sep.toString());
		const n = limit ? toNumber(limit) : null;
		return new ListValue((n === null ? parts : parts.slice(0, n)).map(str));
	}),
	title: method((_env, v, args) => needs("title", args, 0) ?? str(v.value.replace(/(^|\s)(\p{L})/gu, (_m, pre, ch) => pre + ch.toUpperCase()))),
	trim: method((_env, v, args) => needs("trim", args, 0) ?? str(v.value.trim())),
};

const NUMBER: Record<string, Method<NumberValue>> = {
	abs: method((_env, v, args) => needs("abs", args, 0) ?? num(Math.abs(v.value))),
	ceil: method((_env, v, args) => needs("ceil", args, 0) ?? num(Math.ceil(v.value))),
	floor: method((_env, v, args) => needs("floor", args, 0) ?? num(Math.floor(v.value))),
	round: method((_env, v, args) => {
		const bad = needs("round", args, 0, 1);
		if (bad) return bad;
		const digits = args[0] ? numberArg("round", args[0]) : 0;
		if (digits instanceof ErrorValue) return digits;
		const f = 10 ** Math.trunc(digits);
		return num(Math.round(v.value * f) / f);
	}),
	toFixed: method((_env, v, args) => {
		const p = numberArg("toFixed", args[0]);
		if (p instanceof ErrorValue) return p;
		return p >= 0 && p <= 100 ? str(v.value.toFixed(p)) : new ErrorValue("toFixed() precision must be 0 to 100");
	}),
	isEmpty: method((_env, _v, args) => needs("isEmpty", args, 0) ?? bool(false)),
};

function mapList(env: CallEnv, list: ListValue, nodes: Node[], name: string, keep: boolean): Value {
	const bad = needs(name, nodes, 1);
	if (bad) return bad;
	const out: Value[] = [];
	for (const [i, value] of list.items.entries()) {
		const result = env.evaluate(nodes[0], { value, index: num(i) });
		if (result instanceof ErrorValue) return result;
		if (!keep) out.push(result);
		else if (result.isTruthy()) out.push(value);
	}
	return new ListValue(out);
}

function stats(name: string, list: ListValue, fn: (ns: number[]) => number): Value {
	const ns = numbers(list.items);
	if (!ns) return new ErrorValue(`${name}() needs a list of numbers`);
	return ns.length ? num(fn(ns)) : NullValue.value;
}

const LIST: Record<string, Method<ListValue>> = {
	contains: method((_env, v, args) => needs("contains", args, 1) ?? bool(v.includes(args[0]))),
	containsAll: method((_env, v, args) => needs("containsAll", args, 1, Infinity) ?? bool(args.every((a) => v.includes(a)))),
	containsAny: method((_env, v, args) => needs("containsAny", args, 1, Infinity) ?? bool(args.some((a) => v.includes(a)))),
	filter: (env, v, nodes) => mapList(env, v, nodes, "filter", true),
	map: (env, v, nodes) => mapList(env, v, nodes, "map", false),
	reduce: (env, v, nodes) => {
		const bad = needs("reduce", nodes, 2);
		if (bad) return bad;
		let acc = env.evaluate(nodes[1]);
		for (const [i, value] of v.items.entries()) {
			if (acc instanceof ErrorValue) return acc;
			acc = env.evaluate(nodes[0], { value, index: num(i), acc });
		}
		return acc;
	},
	flat: method((_env, v, args) => needs("flat", args, 0) ?? new ListValue(v.items.flatMap((x) => (x instanceof ListValue ? x.items : [x])))),
	isEmpty: method((_env, v, args) => needs("isEmpty", args, 0) ?? bool(v.items.length === 0)),
	join: method((_env, v, args) => needs("join", args, 0, 1) ?? str(v.items.map((x) => x.toString()).join(args[0] ? args[0].toString() : ", "))),
	reverse: method((_env, v, args) => needs("reverse", args, 0) ?? new ListValue([...v.items].reverse())),
	slice: method((_env, v, args) => {
		const bad = needs("slice", args, 1, 2);
		if (bad) return bad;
		const start = numberArg("slice", args[0]);
		const end = args[1] ? numberArg("slice", args[1]) : undefined;
		if (start instanceof ErrorValue) return start;
		if (end instanceof ErrorValue) return end;
		return new ListValue(v.items.slice(start, end));
	}),
	sort: method((_env, v, args) => needs("sort", args, 0) ?? new ListValue([...v.items].sort((a, b) => sortCompare(a, b)))),
	unique: method((_env, v, args) => {
		const bad = needs("unique", args, 0);
		if (bad) return bad;
		const seen = new Set<string>();
		return new ListValue(v.items.filter((x) => !seen.has(groupKey(x)) && !!seen.add(groupKey(x))));
	}),
	// Not in the function reference, but its examples summarize with them.
	mean: method((_env, v, args) => needs("mean", args, 0) ?? stats("mean", v, (ns) => ns.reduce((a, b) => a + b, 0) / ns.length)),
	sum: method((_env, v, args) => needs("sum", args, 0) ?? stats("sum", v, (ns) => ns.reduce((a, b) => a + b, 0))),
	min: method((_env, v, args) => needs("min", args, 0) ?? extreme("min", [v], -1)),
	max: method((_env, v, args) => needs("max", args, 0) ?? extreme("max", [v], 1)),
};

const DATE: Record<string, Method<DateValue>> = {
	date: method((_env, v, args) => needs("date", args, 0) ?? v.dateOnly()),
	format: method((_env, v, args) => needs("format", args, 1) ?? str(moment(v.date).format(args[0].toString()))),
	time: method((_env, v, args) => needs("time", args, 0) ?? str(moment(v.date).format("HH:mm:ss"))),
	relative: method((_env, v, args) => needs("relative", args, 0) ?? str(v.relative())),
	isEmpty: method((_env, _v, args) => needs("isEmpty", args, 0) ?? bool(false)),
};

const FILE: Record<string, Method<FileValue>> = {
	asLink: method((env, v, args) => needs("asLink", args, 0, 1) ?? linkTo(env, v, args[0])),
	hasLink: method((env, v, args) => {
		const bad = needs("hasLink", args, 1);
		if (bad) return bad;
		const target = toFile(env, args[0]);
		if (target) return bool(fileLinksTo(env.scope.app, v.file, target));
		const name = args[0] instanceof LinkValue ? getLinkpath(args[0].link) : args[0].toString();
		return bool(!!name && (env.scope.app.metadataCache.unresolvedLinks[v.file.path]?.[name] ?? 0) > 0);
	}),
	hasProperty: method((env, v, args) => needs("hasProperty", args, 1) ?? bool(Object.hasOwn(frontmatterOf(env.scope.app, v.file) ?? {}, args[0].toString()))),
	hasTag: method((env, v, args) => needs("hasTag", args, 1, Infinity) ?? bool(fileHasTag(env.scope.app, v.file, args.map((a) => a.toString())))),
	inFolder: method((_env, v, args) => needs("inFolder", args, 1) ?? bool(fileInFolder(v.file, args[0].toString()))),
};

const LINK: Record<string, Method<LinkValue>> = {
	asFile: method((env, v, args) => {
		const bad = needs("asFile", args, 0);
		if (bad) return bad;
		const file = v.resolve();
		return file ? new FileValue(env.scope.app, file) : NullValue.value;
	}),
	linksTo: method((env, v, args) => {
		const bad = needs("linksTo", args, 1);
		if (bad) return bad;
		const from = v.resolve();
		const to = toFile(env, args[0]);
		return bool(!!from && !!to && fileLinksTo(env.scope.app, from, to));
	}),
};

const OBJECT: Record<string, Method<ObjectValue>> = {
	isEmpty: method((_env, v, args) => needs("isEmpty", args, 0) ?? bool(v.isEmpty())),
	keys: method((_env, v, args) => needs("keys", args, 0) ?? new ListValue(v.keys().map(str))),
	values: method((_env, v, args) => needs("values", args, 0) ?? new ListValue(v.keys().map((k) => v.get(k) ?? NullValue.value))),
};

const REGEXP: Record<string, Method<RegExpValue>> = {
	matches: method((_env, v, args) => needs("matches", args, 1) ?? bool(new RegExp(v.regexp.source, v.regexp.flags).test(args[0].toString()))),
};

// The method tables that apply to a value, most specific first.
function tables(target: Value): Record<string, Method<any>>[] {
	if (target instanceof LinkValue) return [LINK, STRING];
	if (target instanceof StringValue) return [STRING];
	if (target instanceof NumberValue) return [NUMBER];
	if (target instanceof ListValue) return [LIST];
	if (target instanceof DateValue) return [DATE];
	if (target instanceof FileValue) return [FILE];
	if (target instanceof ObjectValue) return [OBJECT];
	if (target instanceof RegExpValue) return [REGEXP];
	return [];
}

export function callMethod(env: CallEnv, target: Value, name: string, args: Node[]): Value {
	if (target instanceof ErrorValue) return target;
	for (const table of tables(target)) {
		const fn = own(table, name);
		if (fn) return fn(env, target, args);
	}
	const any = own(ANY, name);
	if (any) return any(env, target, args);
	// Calls on a missing value stay missing, so `note.tags.contains("x")` is
	// simply false for a note without tags.
	if (target instanceof NullValue) return NullValue.value;
	return new ErrorValue(`Unknown function "${name}" for ${typeName(target)}`);
}

const DATE_FIELDS: Record<string, (m: moment.Moment) => number> = {
	year: (m) => m.year(),
	month: (m) => m.month() + 1,
	day: (m) => m.date(),
	hour: (m) => m.hour(),
	minute: (m) => m.minute(),
	second: (m) => m.second(),
	millisecond: (m) => m.millisecond(),
};

const DURATION_FIELDS: Record<string, (d: moment.Duration) => number> = {
	days: (d) => d.asDays(),
	hours: (d) => d.asHours(),
	minutes: (d) => d.asMinutes(),
	seconds: (d) => d.asSeconds(),
	milliseconds: (d) => d.asMilliseconds(),
};

export function getField(scope: Scope, target: Value, name: string): Value | undefined {
	if (target instanceof StringValue && name === "length") return num(target.value.length);
	if (target instanceof ListValue && name === "length") return num(target.items.length);
	if (target instanceof DateValue) {
		const field = own(DATE_FIELDS, name);
		return field ? num(field(moment(target.date))) : undefined;
	}
	if (target instanceof DurationValue) {
		const field = own(DURATION_FIELDS, name);
		return field ? num(field(target.duration)) : undefined;
	}
	if (target instanceof FileValue) return fileField(scope.app, target.file, name);
	return undefined;
}
