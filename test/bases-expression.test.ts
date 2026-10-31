import { describe, expect, test } from "bun:test";
import { evaluateExpression, type RowContext, type Scope } from "../src/api/bases/evaluator";
import { normalizePropertyId, parsePropertyId } from "../src/api/bases/property";
import { DateValue, DurationValue, ErrorValue, NullValue, StringValue, TagValue, Value, wrap } from "../src/api/bases/values";

// A row whose note properties come from a plain object, with formulas that
// may refer to each other.
function rowScope(frontmatter: Record<string, unknown>, formulas: Record<string, string> = {}): Scope {
	const scope = { app: {} as any, row: null as RowContext | null, thisRow: null, sourcePath: "" };
	const evaluating = new Set<string>();
	scope.row = {
		file: null,
		fileValue: () => NullValue.value,
		note: (name) => wrap(frontmatter[name]),
		noteObject: () => wrap(frontmatter),
		formula: (name) => {
			if (!(name in formulas)) return NullValue.value;
			if (evaluating.has(name)) return new ErrorValue("cycle");
			evaluating.add(name);
			try {
				return evaluateExpression(formulas[name], scope);
			} finally {
				evaluating.delete(name);
			}
		},
		formulaObject: () => wrap({}),
	};
	return scope;
}

const run = (src: string, frontmatter: Record<string, unknown> = {}, formulas?: Record<string, string>) => evaluateExpression(src, rowScope(frontmatter, formulas));
const text = (src: string, frontmatter?: Record<string, unknown>) => run(src, frontmatter).toString();

describe("Bases formulas", () => {
	// A filter or formula column shows the wrong value if operators bind in another order.
	test("operators bind || < && < equality < comparison < additive < multiplicative < unary", () => {
		expect(text("1 + 2 * 3")).toBe("7");
		expect(text("(1 + 2) * 3")).toBe("9");
		expect(text("-2 + 5")).toBe("3");
		expect(text("1 + 1 == 2 && 3 > 2 || false")).toBe("true");
		expect(text("!false == true")).toBe("true");
		expect(text("10 - 4 - 3")).toBe("3");
	});

	// Bare names, note.x and note["x"] are the three ways a .base file reads a property.
	test("bare names and note.x read the row's properties; formula.x evaluates another formula", () => {
		const fm = { price: 3, qty: 4, "unit price": 2 };
		expect(run("price * qty", fm).toString()).toBe("12");
		expect(run('note.price + note["unit price"]', fm).toString()).toBe("5");
		expect(run("formula.total + 1", fm, { total: "price * qty" }).toString()).toBe("13");
	});

	test("a formula that refers to itself evaluates to an error instead of recursing", () => {
		const value = run("formula.a", {}, { a: "formula.b + 1", b: "formula.a * 2" });
		expect(value).toBeInstanceOf(ErrorValue);
		expect(value.isTruthy()).toBe(false);
	});

	// Due-date columns are date arithmetic; a calendar-unaware duration shifts month ends.
	test("dates add duration strings, subtract to durations, and keep calendar months", () => {
		expect(text('date("2025-01-05") + "1 day"')).toBe("2025-01-06");
		expect(text('date("2025-01-31") + "1M"')).toBe("2025-02-28");
		expect(text('date("2025-01-10") - "2w"')).toBe("2024-12-27");
		expect(text('(date("2025-03-01") - date("2025-02-01")).days')).toBe("28");
		expect(text('date("2025-03-15 10:30:00").hour')).toBe("10");
		expect(text('date("2025-03-15").format("DD/MM/YYYY")')).toBe("15/03/2025");
		expect(text('(duration("1d") * 2 + "12h").hours')).toBe("60");
	});

	test("list functions bind value and index, and reduce threads acc", () => {
		expect(text("[1, 2, 3].reduce(acc + value, 0)")).toBe("6");
		expect(text("[1, 2, 3].map(value * index)")).toBe("0, 2, 6");
		expect(text("[1, 2, 3, 4].filter(value % 2 == 0)")).toBe("2, 4");
		expect(text("[3, 1, 2].sort().reverse().join('-')")).toBe("3-2-1");
		expect(text("[[1], [2, 3]].flat().length")).toBe("3");
		expect(text("[1, 1, 2].unique()")).toBe("1, 2");
	});

	// A malformed formula must show in its cell, not throw out of the whole query.
	test("unknown functions, type errors and parse errors become ErrorValues", () => {
		for (const src of ["nope(1)", '"abc".nope()', "[1] > 2", "1 +", '"open', "10 / 0", 'date("not a date")']) {
			const value = run(src);
			expect(value).toBeInstanceOf(ErrorValue);
			expect(value.isTruthy()).toBe(false);
		}
	});

	// Most notes lack most properties; filters over them must be quietly false.
	test("a missing property stays missing through fields and calls, and isEmpty() reports it", () => {
		expect(run('tags.contains("x")')).toBe(NullValue.value);
		expect(text("missing.isEmpty()")).toBe("true");
		expect(text("missing > 3")).toBe("false");
		expect(run("missing + 1")).toBe(NullValue.value);
		expect(text("if(missing, 'yes', 'no')")).toBe("no");
	});

	test("a slash starts a regular expression only where an operand is expected", () => {
		expect(text('/a.c/i.matches("xABCx")')).toBe("true");
		expect(text("12 / 3 / 2")).toBe("2");
		expect(text('"a-b-c".replace(/-/, "+")')).toBe("a+b-c");
		expect(text('"a-b-c".replace("-", "+")')).toBe("a+b+c");
		expect(text('"a1b22c".split(/\\d+/)')).toBe("a, b, c");
	});

	// `status == "done"` and `year == "2024"` compare frontmatter of mixed types.
	test("loose equality crosses numbers and numeric strings, and tags ignore case and '#'", () => {
		expect(text('year == "2024"', { year: 2024 })).toBe("true");
		expect(text("year != 2025", { year: 2024 })).toBe("true");
		expect(Value.looseEquals(new TagValue("#Book"), new StringValue("book"))).toBe(true);
		expect(Value.looseEquals(new StringValue("book"), new TagValue("Book"))).toBe(true);
	});

	test("string and number methods", () => {
		expect(text('"hello wide world".title()')).toBe("Hello Wide World");
		expect(text('"a,b,c".split(",", 2)')).toBe("a, b");
		expect(text('"abc".slice(1).length')).toBe("2");
		expect(text("(5.567).round(1)")).toBe("5.6");
		expect(text("(2).toFixed(2)")).toBe("2.00");
		expect(text('"x".containsAny("y", "x")')).toBe("true");
	});
});

describe("Bases value parsing", () => {
	test("DateValue.parseFromString takes ISO dates and datetimes, and rejects the rest", () => {
		expect(DateValue.parseFromString("2025-12-31")?.toString()).toBe("2025-12-31");
		expect(DateValue.parseFromString("2025-12-31T23:59")?.toString()).toBe("2025-12-31 23:59");
		expect(DateValue.parseFromString("2025-12-31T23:59:59Z-07")?.date.toISOString()).toBe("2026-01-01T06:59:59.000Z");
		expect(DateValue.parseFromString("31/12/2025")).toBeNull();
		expect(DateValue.parseFromString("2025-13-45")).toBeNull();
	});

	test("DurationValue.parseFromString takes ISO 8601 and the formula forms", () => {
		expect(DurationValue.parseFromString("P1DT2H")?.getMilliseconds()).toBe(26 * 3600_000);
		expect(DurationValue.parseFromString("1 day")?.getMilliseconds()).toBe(86400_000);
		expect(DurationValue.parseFromString("2w")?.getMilliseconds()).toBe(14 * 86400_000);
		expect(DurationValue.parseFromString("90m")?.getMilliseconds()).toBe(90 * 60_000);
		expect(DurationValue.parseFromString("3 fortnights")).toBeNull();
		expect(DurationValue.parseFromString("")).toBeNull();
	});

	test("property ids split at the first dot, and a bare name is a note property", () => {
		expect(parsePropertyId("note.a.b")).toEqual({ type: "note", name: "a.b" });
		expect(parsePropertyId("formula.total")).toEqual({ type: "formula", name: "total" });
		expect(normalizePropertyId("status")).toBe("note.status");
		expect(normalizePropertyId("file.name")).toBe("file.name");
		expect(normalizePropertyId("note.")).toBeNull();
		expect(normalizePropertyId(3)).toBeNull();
	});
});
