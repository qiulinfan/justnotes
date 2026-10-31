// Coercion and ordering shared by operators, list functions, sorting and summaries.
import moment from "moment";
import {
	BooleanValue,
	DateValue,
	DurationValue,
	FileValue,
	LinkValue,
	ListValue,
	NullValue,
	NumberValue,
	ObjectValue,
	PrimitiveValue,
	StringValue,
	TagValue,
	type Value,
	valueTypes,
} from "./values";

export function typeName(value: Value) {
	return valueTypes(value)[0] ?? "value";
}

// A number from a number, a boolean, or a string that spells one.
export function toNumber(value: Value): number | null {
	if (value instanceof NumberValue) return value.value;
	if (value instanceof BooleanValue) return value.value ? 1 : 0;
	if (value instanceof StringValue && !(value instanceof LinkValue)) {
		const text = value.value.trim();
		if (text !== "" && Number.isFinite(Number(text))) return Number(text);
	}
	return null;
}

export function toDate(value: Value): DateValue | null {
	if (value instanceof DateValue) return value;
	if (value instanceof StringValue && !(value instanceof LinkValue)) return DateValue.parseFromString(value.value);
	return null;
}

export function toDuration(value: Value): DurationValue | null {
	if (value instanceof DurationValue) return value;
	if (value instanceof StringValue && !(value instanceof LinkValue)) return DurationValue.parseFromString(value.value);
	return null;
}

// Every unit of a duration times n, so "1 month" * 2 stays two calendar months.
export function scaleDuration(d: DurationValue, n: number) {
	const x = d.duration;
	return new DurationValue(
		moment.duration({
			years: x.years() * n,
			months: x.months() * n,
			days: x.days() * n,
			hours: x.hours() * n,
			minutes: x.minutes() * n,
			seconds: x.seconds() * n,
			milliseconds: x.milliseconds() * n,
		}),
	);
}

export function dateDifference(a: DateValue, b: DateValue) {
	// Two calendar dates differ by whole days, even across a DST change.
	if (!a.time && !b.time) return DurationValue.fromMilliseconds(moment(a.date).startOf("day").diff(moment(b.date).startOf("day"), "days") * 86400000);
	return DurationValue.fromMilliseconds(a.date.getTime() - b.date.getTime());
}

export function isEmptyValue(value: Value) {
	if (value instanceof NullValue) return true;
	if (value instanceof StringValue) return value.value === "";
	if (value instanceof ListValue) return value.items.length === 0;
	if (value instanceof ObjectValue) return value.isEmpty();
	return false;
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const codeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Order two values for <, >, min/max and sort(): numbers by size, dates by
// time, strings by `collate`. Null when they have no order.
export function compareValues(a: Value, b: Value, collate = codeUnits): number | null {
	if (a instanceof NullValue || b instanceof NullValue) return null;
	if (a instanceof DateValue || b instanceof DateValue) {
		const x = toDate(a);
		const y = toDate(b);
		return x && y ? sign(x.date.getTime() - y.date.getTime()) : null;
	}
	if (a instanceof DurationValue || b instanceof DurationValue) {
		const x = toDuration(a);
		const y = toDuration(b);
		return x && y ? sign(x.getMilliseconds() - y.getMilliseconds()) : null;
	}
	if (a instanceof NumberValue || b instanceof NumberValue || a instanceof BooleanValue || b instanceof BooleanValue) {
		const x = toNumber(a);
		const y = toNumber(b);
		if (x !== null && y !== null) return sign(x - y);
	}
	if (a instanceof PrimitiveValue && b instanceof PrimitiveValue) return collate(a.toString(), b.toString());
	if (a instanceof FileValue && b instanceof FileValue) return collate(a.file.path, b.file.path);
	if (a instanceof ListValue && b instanceof ListValue) return collate(a.toString(), b.toString());
	return null;
}

function rank(value: Value) {
	if (value instanceof NumberValue) return 0;
	if (value instanceof DateValue) return 1;
	if (value instanceof DurationValue) return 2;
	if (value instanceof BooleanValue) return 3;
	if (value instanceof StringValue) return 4;
	if (value instanceof ListValue) return 5;
	if (value instanceof FileValue) return 6;
	return 7;
}

// A total order for sorting rows: natural string order, values of different
// types by type, and empty values last in either direction.
export function sortCompare(a: Value | null, b: Value | null, direction: "ASC" | "DESC" = "ASC") {
	const x = a ?? NullValue.value;
	const y = b ?? NullValue.value;
	const ex = isEmptyValue(x);
	const ey = isEmptyValue(y);
	if (ex || ey) return ex === ey ? 0 : ex ? 1 : -1;
	const c = compareValues(x, y, collator.compare) ?? (rank(x) - rank(y) || collator.compare(x.toString(), y.toString()));
	return direction === "DESC" ? -c : c;
}

// A string that is equal for values that group together: links by the file
// they resolve to, tags without case or '#'.
export function groupKey(value: Value): string {
	if (value instanceof NullValue) return "null";
	if (value instanceof LinkValue) return `file:${value.resolve()?.path ?? value.link.toLowerCase()}`;
	if (value instanceof FileValue) return `file:${value.file.path}`;
	if (value instanceof TagValue) return `tag:${value.value.replace(/^#/, "").toLowerCase()}`;
	if (value instanceof DateValue) return `date:${value.date.getTime()}`;
	if (value instanceof ListValue) return `list:${value.items.map(groupKey).join("\u0001")}`;
	return `${typeName(value)}:${value.toString()}`;
}
