// Evaluates parsed formulas over Values. Evaluation never throws: a type error,
// an unknown function or a parse error becomes an ErrorValue.
import moment from "moment";
import type { App } from "../app";
import type { TFile } from "../vault";
import { compareValues, dateDifference, scaleDuration, toDuration, toNumber, typeName } from "./compare";
import { type BinaryOp, type Node, parseExpression } from "./expression";
import { type CallEnv, callGlobal, callMethod, getField } from "./functions";
import {
	BooleanValue,
	DateValue,
	DurationValue,
	ErrorValue,
	ListValue,
	NotNullValue,
	NullValue,
	NumberValue,
	ObjectValue,
	RegExpValue,
	StringValue,
	Value,
} from "./values";

// One row a formula reads: `file`, `note` and `formula` resolve against it.
export interface RowContext {
	readonly file: TFile | null;
	fileValue(): Value;
	note(name: string): Value;
	noteObject(): Value;
	formula(name: string): Value;
	formulaObject(): Value;
}

export interface Scope {
	app: App;
	// The row being evaluated; null in a summary formula.
	row: RowContext | null;
	// `this`: the base file, the note that embeds the base, or the active file.
	thisRow: RowContext | null;
	// Where link() and file() resolve relative paths from.
	sourcePath: string;
	// Bound variables: value, index and acc in list functions, values in summaries.
	vars?: Record<string, Value>;
}

// `this` in a formula. `this.file` is its file, `this.status` a property of it.
export class ThisValue extends NotNullValue {
	row: RowContext;

	constructor(row: RowContext) {
		super();
		this.row = row;
	}

	get(name: string): Value {
		if (name === "file") return this.row.fileValue();
		if (name === "note") return this.row.noteObject();
		if (name === "formula") return this.row.formulaObject();
		return this.row.note(name);
	}

	toString() {
		return this.row.file?.path ?? "";
	}

	isTruthy() {
		return true;
	}

	looseEquals(other: Value) {
		return this.row.fileValue().looseEquals(other);
	}
}

export function evaluateExpression(src: string, scope: Scope): Value {
	const parsed = parseExpression(src);
	if (!parsed.node) return new ErrorValue(parsed.error);
	try {
		return evaluate(parsed.node, scope);
	} catch (err) {
		return new ErrorValue((err as Error)?.message ?? String(err));
	}
}

function bound(scope: Scope, name: string) {
	return scope.vars && Object.hasOwn(scope.vars, name) ? scope.vars[name] : undefined;
}

export function evaluate(node: Node, scope: Scope): Value {
	switch (node.kind) {
		case "literal":
			return node.value;
		case "regexp":
			return new RegExpValue(new RegExp(node.source, node.flags));
		case "ident":
			return identifier(node.name, scope);
		case "member": {
			// `note.x` and `formula.x` read the row directly instead of building
			// the whole object first.
			const obj = node.object;
			if (obj.kind === "ident" && scope.row && !bound(scope, obj.name)) {
				if (obj.name === "note") return scope.row.note(node.name);
				if (obj.name === "formula") return scope.row.formula(node.name);
			}
			return member(evaluate(obj, scope), node.name, scope);
		}
		case "index": {
			const target = evaluate(node.object, scope);
			const key = evaluate(node.index, scope);
			return index(target, key, scope);
		}
		case "call":
			return call(node.callee, node.args, scope);
		case "unary":
			return unary(node.op, evaluate(node.arg, scope));
		case "binary":
			return binary(node.op, node.left, node.right, scope);
		case "list": {
			const items = node.items.map((n) => evaluate(n, scope));
			return items.find((v) => v instanceof ErrorValue) ?? new ListValue(items);
		}
		case "object": {
			const data: Record<string, Value> = {};
			for (const [key, n] of node.entries) {
				const v = evaluate(n, scope);
				if (v instanceof ErrorValue) return v;
				data[key] = v;
			}
			return new ObjectValue(data);
		}
	}
}

function identifier(name: string, scope: Scope): Value {
	const value = bound(scope, name);
	if (value) return value;
	const { row } = scope;
	switch (name) {
		case "file":
			return row ? row.fileValue() : NullValue.value;
		case "note":
			return row ? row.noteObject() : NullValue.value;
		case "formula":
			return row ? row.formulaObject() : NullValue.value;
		case "this":
			return scope.thisRow ? new ThisValue(scope.thisRow) : NullValue.value;
	}
	// A bare name is a note property.
	return row ? row.note(name) : NullValue.value;
}

function member(target: Value, name: string, scope: Scope): Value {
	if (target instanceof ErrorValue) return target;
	if (target instanceof NullValue) return NullValue.value;
	if (target instanceof ThisValue) return target.get(name);
	if (target instanceof ObjectValue) return target.get(name) ?? NullValue.value;
	return getField(scope, target, name) ?? new ErrorValue(`${typeName(target)} has no property "${name}"`);
}

function index(target: Value, key: Value, scope: Scope): Value {
	if (target instanceof ErrorValue) return target;
	if (key instanceof ErrorValue) return key;
	if (target instanceof NullValue) return NullValue.value;
	if (target instanceof ListValue || (target instanceof StringValue && key instanceof NumberValue)) {
		const n = toNumber(key);
		if (n === null || !Number.isInteger(n)) return new ErrorValue(`Index must be a whole number, not "${key.toString()}"`);
		if (target instanceof ListValue) return target.get(n < 0 ? target.items.length + n : n);
		const ch = (target as StringValue).value.at(n);
		return ch === undefined ? NullValue.value : new StringValue(ch);
	}
	return member(target, key.toString(), scope);
}

function call(callee: Node, args: Node[], scope: Scope): Value {
	const env: CallEnv = {
		scope,
		evaluate: (n, vars) => evaluate(n, vars ? { ...scope, vars: { ...scope.vars, ...vars } } : scope),
	};
	if (callee.kind === "ident") return callGlobal(env, callee.name, args);
	if (callee.kind !== "member") return new ErrorValue("Only functions can be called");
	let target = evaluate(callee.object, scope);
	// `this.hasTag(...)` and friends act on this file.
	if (target instanceof ThisValue) target = target.row.fileValue();
	return callMethod(env, target, callee.name, args);
}

function unary(op: "!" | "-", v: Value): Value {
	if (v instanceof ErrorValue) return v;
	if (op === "!") return new BooleanValue(!v.isTruthy());
	if (v instanceof NullValue) return v;
	if (v instanceof DurationValue) return scaleDuration(v, -1);
	const n = toNumber(v);
	return n === null ? new ErrorValue(`Cannot negate ${typeName(v)}`) : new NumberValue(-n);
}

function binary(op: BinaryOp, left: Node, right: Node, scope: Scope): Value {
	if (op === "&&" || op === "||") {
		const a = evaluate(left, scope);
		if (a instanceof ErrorValue) return a;
		if (op === "&&" ? !a.isTruthy() : a.isTruthy()) return new BooleanValue(op === "||");
		const b = evaluate(right, scope);
		return b instanceof ErrorValue ? b : new BooleanValue(b.isTruthy());
	}
	const a = evaluate(left, scope);
	if (a instanceof ErrorValue) return a;
	const b = evaluate(right, scope);
	if (b instanceof ErrorValue) return b;
	switch (op) {
		case "==":
			return new BooleanValue(Value.looseEquals(a, b));
		case "!=":
			return new BooleanValue(!Value.looseEquals(a, b));
		case "<":
		case ">":
		case "<=":
		case ">=": {
			const c = compareValues(a, b);
			if (c === null) {
				// A missing value is never less or greater than anything.
				if (a instanceof NullValue || b instanceof NullValue) return new BooleanValue(false);
				return new ErrorValue(`Cannot compare ${typeName(a)} and ${typeName(b)}`);
			}
			return new BooleanValue(op === "<" ? c < 0 : op === ">" ? c > 0 : op === "<=" ? c <= 0 : c >= 0);
		}
		case "+":
			return add(a, b);
		case "-":
			return subtract(a, b);
		default:
			return multiply(op, a, b);
	}
}

const cannot = (verb: string, a: Value, b: Value) => new ErrorValue(`Cannot ${verb} ${typeName(a)} and ${typeName(b)}`);

function add(a: Value, b: Value): Value {
	if (a instanceof DateValue || b instanceof DateValue) {
		const date = (a instanceof DateValue ? a : b) as DateValue;
		const other = a instanceof DateValue ? b : a;
		if (other instanceof NullValue) return NullValue.value;
		const d = toDuration(other);
		if (d) return d.addToDate(date);
		if (other instanceof StringValue) return new StringValue(a.toString() + b.toString());
		return cannot("add", a, b);
	}
	if (a instanceof DurationValue || b instanceof DurationValue) {
		const x = toDuration(a);
		const y = toDuration(b);
		if (x && y) return new DurationValue(moment.duration(x.duration).add(y.duration));
	}
	if (a instanceof ListValue && b instanceof ListValue) return a.concat(b);
	if (a instanceof StringValue || b instanceof StringValue) return new StringValue(a.toString() + b.toString());
	if (a instanceof NullValue || b instanceof NullValue) return NullValue.value;
	const x = toNumber(a);
	const y = toNumber(b);
	return x !== null && y !== null ? new NumberValue(x + y) : cannot("add", a, b);
}

function subtract(a: Value, b: Value): Value {
	if (a instanceof NullValue || b instanceof NullValue) return NullValue.value;
	if (a instanceof DateValue) {
		if (b instanceof DateValue) return dateDifference(a, b);
		const d = toDuration(b);
		if (d) return d.addToDate(a, true);
		const other = b instanceof StringValue ? DateValue.parseFromString(b.value) : null;
		return other ? dateDifference(a, other) : cannot("subtract", a, b);
	}
	if (b instanceof DateValue) {
		const date = a instanceof StringValue ? DateValue.parseFromString(a.value) : null;
		return date ? dateDifference(date, b) : cannot("subtract", a, b);
	}
	if (a instanceof DurationValue || b instanceof DurationValue) {
		const x = toDuration(a);
		const y = toDuration(b);
		if (x && y) return new DurationValue(moment.duration(x.duration).subtract(y.duration));
	}
	const x = toNumber(a);
	const y = toNumber(b);
	return x !== null && y !== null ? new NumberValue(x - y) : cannot("subtract", a, b);
}

function multiply(op: "*" | "/" | "%", a: Value, b: Value): Value {
	if (a instanceof NullValue || b instanceof NullValue) return NullValue.value;
	const verb = op === "*" ? "multiply" : "divide";
	if (a instanceof DurationValue || b instanceof DurationValue) {
		if (op === "/" && a instanceof DurationValue && b instanceof DurationValue) {
			return b.getMilliseconds() === 0 ? new ErrorValue("Division by zero") : new NumberValue(a.getMilliseconds() / b.getMilliseconds());
		}
		const d = (a instanceof DurationValue ? a : b) as DurationValue;
		const n = toNumber(a instanceof DurationValue ? b : a);
		if (n === null || op === "%" || (op === "/" && !(a instanceof DurationValue))) return cannot(verb, a, b);
		if (op === "/" && n === 0) return new ErrorValue("Division by zero");
		return op === "*" ? scaleDuration(d, n) : DurationValue.fromMilliseconds(d.getMilliseconds() / n);
	}
	const x = toNumber(a);
	const y = toNumber(b);
	if (x === null || y === null) return cannot(verb, a, b);
	if (op !== "*" && y === 0) return new ErrorValue("Division by zero");
	return new NumberValue(op === "*" ? x * y : op === "/" ? x / y : x % y);
}
