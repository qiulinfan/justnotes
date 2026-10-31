import DOMPurify from "dompurify";
import moment from "moment";
import type { App } from "../app";
import { setIcon } from "../icons";
import { Keymap } from "../keymap";
import { getLinkpath } from "../metadata-utils";
import type { TFile } from "../vault";

// The object a rendered value hands to hover previews; app.renderContext is one.
export interface HoverParentLike {
	hoverPopover?: unknown;
}

// The Values formulas compute with (Obsidian 1.10). Every class carries a
// static `type`, which isType() and plugin views read.
export abstract class Value {
	static type = "value";

	static equals(a: Value | null, b: Value | null): boolean {
		return (a ?? NullValue.value).equals((b ?? NullValue.value) as any);
	}

	// Loose equality is symmetric: a link equals the string that names its file
	// whichever side the link is on.
	static looseEquals(a: Value | null, b: Value | null): boolean {
		const x = a ?? NullValue.value;
		const y = b ?? NullValue.value;
		return x.looseEquals(y) || y.looseEquals(x);
	}

	abstract toString(): string;
	abstract isTruthy(): boolean;

	equals(other: this): boolean {
		return other === this;
	}

	looseEquals(other: Value): boolean {
		return this.equals(other as this);
	}

	renderTo(el: HTMLElement, _ctx?: HoverParentLike | null) {
		el.appendText(this.toString());
	}
}

export abstract class NotNullValue extends Value {}

export class NullValue extends Value {
	static type = "null";
	static value = new NullValue();

	toString() {
		return "";
	}

	isTruthy() {
		return false;
	}

	equals(other: Value) {
		return other instanceof NullValue;
	}

	looseEquals(other: Value) {
		return other instanceof NullValue;
	}

	renderTo() {}
}

// What a failed formula evaluates to: shown in its cell, falsy in filters.
// Obsidian names it in docs but does not export it.
export class ErrorValue extends NotNullValue {
	static type = "error";
	message: string;

	constructor(message: string) {
		super();
		this.message = message;
	}

	toString() {
		return `Error: ${this.message}`;
	}

	isTruthy() {
		return false;
	}

	looseEquals() {
		return false;
	}

	renderTo(el: HTMLElement) {
		el.createSpan({ cls: "bases-error-value", text: "Error", attr: { "aria-label": this.message, title: this.message } });
	}
}

export abstract class PrimitiveValue<T> extends NotNullValue {
	value: T;

	constructor(value: T) {
		super();
		this.value = value;
	}

	toString() {
		return String(this.value);
	}

	isTruthy() {
		return !!this.value;
	}

	equals(other: Value) {
		return other instanceof PrimitiveValue && other.constructor === this.constructor && other.value === this.value;
	}

	// Across strings, numbers and booleans, the way frontmatter comparisons
	// need it: `year == "2024"` matches the number 2024.
	looseEquals(other: Value) {
		if (!(other instanceof PrimitiveValue)) return false;
		const a: unknown = this.value;
		const b: unknown = other.value;
		if (typeof a === typeof b) return a === b;
		if (typeof a === "string" || typeof b === "string") {
			const s = String(typeof a === "string" ? a : b).trim();
			const o = typeof a === "string" ? b : a;
			if (typeof o === "number") return s !== "" && Number(s) === o;
			return s.toLowerCase() === String(o);
		}
		return Number(a) === Number(b);
	}
}

export class StringValue extends PrimitiveValue<string> {
	static type = "string";
}

export class NumberValue extends PrimitiveValue<number> {
	static type = "number";
}

export class BooleanValue extends PrimitiveValue<boolean> {
	static type = "boolean";

	renderTo(el: HTMLElement) {
		el.createEl("input", { type: "checkbox", cls: "metadata-input-checkbox", attr: { disabled: true } }).checked = this.value;
	}
}

export class DateValue extends NotNullValue {
	static type = "date";
	date: Date;
	// False for a calendar date (`2025-01-05`), true when a time of day was given.
	time: boolean;

	constructor(date: Date, time = true) {
		super();
		this.date = date;
		this.time = time;
	}

	toString() {
		return moment(this.date).format(this.time ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD");
	}

	isTruthy() {
		return !Number.isNaN(this.date.getTime());
	}

	dateOnly() {
		return new DateValue(moment(this.date).startOf("day").toDate(), false);
	}

	relative() {
		return moment(this.date).fromNow();
	}

	equals(other: Value) {
		return other instanceof DateValue && other.date.getTime() === this.date.getTime();
	}

	looseEquals(other: Value) {
		if (other instanceof DateValue) return this.equals(other);
		if (other instanceof StringValue && !(other instanceof LinkValue)) {
			const parsed = DateValue.parseFromString(other.value);
			return !!parsed && parsed.date.getTime() === this.date.getTime();
		}
		return false;
	}

	// ISO 8601 date or datetime: "2025-12-31", "2025-12-31T23:59",
	// "2025-12-31 23:59:59", "2025-12-31T23:59:59Z-07" (a Z before an offset is
	// dropped).
	static parseFromString(input: string): DateValue | null {
		const text = String(input)
			.trim()
			.replace(/Z(?=[+-]\d\d(?::?\d\d)?$)/, "");
		if (!/^\d{4}-\d\d-\d\d/.test(text)) return null;
		const m = moment(text, moment.ISO_8601, true);
		return m.isValid() ? new DateValue(m.toDate(), text.length > 10) : null;
	}
}

export class RelativeDateValue extends DateValue {
	renderTo(el: HTMLElement) {
		el.createSpan({ text: this.relative(), attr: { title: DateValue.prototype.toString.call(this) } });
	}
}

const DURATION_UNITS: Record<string, moment.unitOfTime.Base> = {
	y: "years",
	year: "years",
	years: "years",
	M: "months",
	month: "months",
	months: "months",
	w: "weeks",
	week: "weeks",
	weeks: "weeks",
	d: "days",
	day: "days",
	days: "days",
	h: "hours",
	hour: "hours",
	hours: "hours",
	m: "minutes",
	minute: "minutes",
	minutes: "minutes",
	s: "seconds",
	second: "seconds",
	seconds: "seconds",
	ms: "milliseconds",
	millisecond: "milliseconds",
	milliseconds: "milliseconds",
};

// `M` is a month and `m` a minute; spelled-out units ignore case.
function durationUnit(unit: string) {
	return DURATION_UNITS[unit] ?? (unit.length > 2 ? DURATION_UNITS[unit.toLowerCase()] : undefined);
}

export class DurationValue extends NotNullValue {
	static type = "duration";
	duration: moment.Duration;

	constructor(duration: moment.Duration) {
		super();
		this.duration = duration;
	}

	toString() {
		const ms = this.getMilliseconds();
		const text = moment.duration(Math.abs(ms)).humanize();
		return ms < 0 ? `-${text}` : text;
	}

	isTruthy() {
		return this.getMilliseconds() !== 0;
	}

	// Calendar units stay calendar units: one month from Jan 31 is Feb 28.
	addToDate(value: DateValue, subtract = false) {
		const m = moment(value.date);
		if (subtract) m.subtract(this.duration);
		else m.add(this.duration);
		const d = this.duration;
		const timeOfDay = d.hours() !== 0 || d.minutes() !== 0 || d.seconds() !== 0 || d.milliseconds() !== 0;
		return new DateValue(m.toDate(), value.time || timeOfDay);
	}

	getMilliseconds() {
		return this.duration.asMilliseconds();
	}

	// An ISO 8601 duration ("P1DT2H"), or the date arithmetic form formulas use:
	// "1 day", "2w", "3 months", "1y 2M".
	static parseFromString(input: string): DurationValue | null {
		const text = String(input).trim();
		if (/^[+-]?P/i.test(text)) {
			const d = moment.duration(text.toUpperCase());
			return d.isValid() && (d.asMilliseconds() !== 0 || /\d/.test(text)) ? new DurationValue(d) : null;
		}
		const parts: moment.DurationInputObject = {};
		let rest = text;
		let sign = 1;
		if (rest.startsWith("-")) {
			sign = -1;
			rest = rest.slice(1).trim();
		} else if (rest.startsWith("+")) rest = rest.slice(1).trim();
		if (!rest) return null;
		const re = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)[\s,]*/;
		while (rest) {
			const m = re.exec(rest);
			const unit = m && durationUnit(m[2]);
			if (!m || !unit) return null;
			parts[unit] = (parts[unit] ?? 0) + sign * Number(m[1]);
			rest = rest.slice(m[0].length);
		}
		return new DurationValue(moment.duration(parts));
	}

	static fromMilliseconds(milliseconds: number) {
		return new DurationValue(moment.duration(milliseconds));
	}

	equals(other: Value) {
		return other instanceof DurationValue && other.getMilliseconds() === this.getMilliseconds();
	}
}

// app.renderContext (Obsidian 1.10), when this App has one.
export function renderContextOf(app: App): HoverParentLike | null {
	return (app as { renderContext?: HoverParentLike }).renderContext ?? null;
}

// An <a class="internal-link"> that opens like a link in a note: Mod opens a
// new tab, and hovering asks for a page preview.
export function renderInternalLink(app: App, el: HTMLElement, linktext: string, sourcePath: string, text: string, resolved: boolean, hoverParent?: HoverParentLike | null) {
	const a = el.createEl("a", { cls: "internal-link", text, href: linktext, attr: { "data-href": linktext } });
	if (!resolved) a.addClass("is-unresolved");
	const open = (evt: MouseEvent) => {
		evt.preventDefault();
		evt.stopPropagation();
		app.workspace.openLinkText(linktext, sourcePath, Keymap.isModEvent(evt));
	};
	a.addEventListener("click", open);
	a.addEventListener("auxclick", (evt) => evt.button === 1 && open(evt));
	a.addEventListener("mouseover", (event) =>
		app.workspace.trigger("hover-link", { event, source: "bases", hoverParent: hoverParent ?? null, targetEl: a, linktext, sourcePath }),
	);
	return a;
}

export class FileValue extends NotNullValue {
	static type = "file";
	app: App;
	file: TFile;

	constructor(app: App, file: TFile) {
		super();
		this.app = app;
		this.file = file;
	}

	toString() {
		return this.file.path;
	}

	isTruthy() {
		return true;
	}

	equals(other: Value) {
		return other instanceof FileValue && other.file.path === this.file.path;
	}

	looseEquals(other: Value) {
		if (other instanceof FileValue) return this.equals(other);
		if (other instanceof LinkValue) return other.resolve()?.path === this.file.path;
		if (other instanceof StringValue) return other.value === this.file.path;
		return false;
	}

	renderTo(el: HTMLElement, ctx?: HoverParentLike | null) {
		const linktext = this.app.metadataCache.fileToLinktext(this.file, "", true);
		const text = this.file.extension === "md" ? this.file.basename : this.file.name;
		renderInternalLink(this.app, el, linktext, "", text, true, ctx);
	}
}

export class LinkValue extends StringValue {
	static type = "link";
	app: App;
	// The link target as written, with any #heading or #^block subpath.
	link: string;
	display: string | null;
	sourcePath: string;
	// Resolving can scan every file, and grouping compares links often. Values
	// live for one query run, so the answer cannot go stale in practice.
	#target: TFile | null | undefined;

	constructor(app: App, link: string, sourcePath: string, display?: string | null) {
		super(display ? `[[${link}|${display}]]` : `[[${link}]]`);
		this.app = app;
		this.link = link;
		this.display = display ?? null;
		this.sourcePath = sourcePath;
	}

	resolve(): TFile | null {
		if (this.#target === undefined) this.#target = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(this.link), this.sourcePath);
		return this.#target;
	}

	isTruthy() {
		return this.link !== "";
	}

	// Links are equal when they resolve to the same file; a plain string matches
	// a link it would resolve the same way.
	looseEquals(other: Value) {
		const target = this.resolve();
		if (other instanceof LinkValue) {
			const theirs = other.resolve();
			return target && theirs ? target === theirs : getLinkpath(this.link).toLowerCase() === getLinkpath(other.link).toLowerCase();
		}
		if (other instanceof FileValue) return target === other.file;
		if (other instanceof StringValue && !(other instanceof TagValue)) {
			const asLink = LinkValue.parseFromString(this.app, other.value, this.sourcePath);
			if (asLink) return this.looseEquals(asLink);
			const named = other.value ? this.app.metadataCache.getFirstLinkpathDest(getLinkpath(other.value), this.sourcePath) : null;
			return named ? named === target : other.value === this.link;
		}
		return false;
	}

	renderTo(el: HTMLElement, ctx?: HoverParentLike | null) {
		const text = this.display ?? this.link.replace(/\.md(?=$|#)/, "");
		renderInternalLink(this.app, el, this.link, this.sourcePath, text, !!this.resolve(), ctx);
	}

	// "[[Target]]" or "[[Target|Alias]]"; anything else is not a link.
	static parseFromString(app: App, input: string, sourcePath: string): LinkValue | null {
		const m = /^\s*!?\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]\s*$/.exec(String(input));
		return m ? new LinkValue(app, m[1].trim(), sourcePath, m[2]) : null;
	}
}

export class ListValue extends NotNullValue {
	static type = "list";
	items: Value[];

	// Wraps the elements of the given array in place, as Obsidian's does.
	constructor(value: (unknown | Value)[]) {
		super();
		for (let i = 0; i < value.length; i++) value[i] = wrap(value[i]);
		this.items = value as Value[];
	}

	toString() {
		return this.items.map((v) => v.toString()).join(", ");
	}

	isTruthy() {
		return this.items.length > 0;
	}

	includes(value: Value) {
		return this.items.some((v) => Value.looseEquals(v, value));
	}

	length() {
		return this.items.length;
	}

	get(index: number): Value {
		return this.items[index] ?? NullValue.value;
	}

	concat(other: ListValue) {
		return new ListValue([...this.items, ...other.items]);
	}

	equals(other: Value) {
		return other instanceof ListValue && other.items.length === this.items.length && this.items.every((v, i) => Value.equals(v, other.items[i]));
	}

	looseEquals(other: Value) {
		return other instanceof ListValue && other.items.length === this.items.length && this.items.every((v, i) => Value.looseEquals(v, other.items[i]));
	}

	renderTo(el: HTMLElement, ctx?: HoverParentLike | null) {
		this.items.forEach((v, i) => {
			if (i > 0) el.appendText(", ");
			v.renderTo(el.createSpan("bases-list-element"), ctx);
		});
	}
}

export class ObjectValue extends NotNullValue {
	static type = "object";
	data: Record<string, unknown>;
	#member: (key: string, raw: unknown) => Value;

	// `member` wraps a raw member on access; frontmatter objects pass one that
	// knows property types and links.
	constructor(value: Record<string, unknown>, member: (key: string, raw: unknown) => Value = (_k, raw) => wrap(raw)) {
		super();
		this.data = value;
		this.#member = member;
	}

	toString() {
		return JSON.stringify(this.data, (_k, v) => (v instanceof Value ? v.toString() : v));
	}

	isTruthy() {
		return !this.isEmpty();
	}

	isEmpty() {
		return Object.keys(this.data).length === 0;
	}

	keys() {
		return Object.keys(this.data);
	}

	get(key: string): Value | null {
		return Object.hasOwn(this.data, key) ? this.#member(key, this.data[key]) : NullValue.value;
	}

	equals(other: Value) {
		return other instanceof ObjectValue && this.#sameMembers(other, Value.equals);
	}

	looseEquals(other: Value) {
		return other instanceof ObjectValue && this.#sameMembers(other, Value.looseEquals);
	}

	#sameMembers(other: ObjectValue, eq: (a: Value | null, b: Value | null) => boolean) {
		const keys = this.keys();
		return keys.length === other.keys().length && keys.every((k) => Object.hasOwn(other.data, k) && eq(this.get(k), other.get(k)));
	}
}

export class RegExpValue extends NotNullValue {
	static type = "regexp";
	regexp: RegExp;

	constructor(regexp: RegExp) {
		super();
		this.regexp = regexp;
	}

	toString() {
		return this.regexp.toString();
	}

	isTruthy() {
		return true;
	}

	equals(other: Value) {
		return other instanceof RegExpValue && other.regexp.toString() === this.regexp.toString();
	}
}

const bareTag = (tag: string) => tag.replace(/^#/, "").toLowerCase();

export class TagValue extends StringValue {
	static type = "tag";

	constructor(value: string) {
		super(String(value).startsWith("#") ? String(value) : `#${value}`);
	}

	// Tags ignore case and the leading '#': `#Book` equals "book".
	looseEquals(other: Value) {
		return other instanceof StringValue && !(other instanceof LinkValue) && bareTag(other.value) === bareTag(this.value);
	}

	renderTo(el: HTMLElement) {
		el.createEl("a", { cls: "tag", text: this.value, href: this.value });
	}
}

export class UrlValue extends StringValue {
	static type = "url";
	display: string | null;

	constructor(url: string, display?: string | null) {
		super(url);
		this.display = display ?? null;
	}

	renderTo(el: HTMLElement) {
		el.createEl("a", { cls: "external-link", text: this.display ?? this.value, href: this.value, attr: { target: "_blank", rel: "noopener nofollow" } });
	}
}

export class HTMLValue extends StringValue {
	static type = "html";

	renderTo(el: HTMLElement) {
		el.appendChild(DOMPurify.sanitize(this.value, { RETURN_DOM_FRAGMENT: true }));
	}
}

export class IconValue extends StringValue {
	static type = "icon";

	renderTo(el: HTMLElement) {
		setIcon(el.createSpan("bases-icon"), this.value);
	}
}

export class ImageValue extends StringValue {
	static type = "image";
	app: App | null;
	sourcePath: string;

	// A URL, a vault path, or a link to an attachment.
	constructor(value: string, app?: App | null, sourcePath = "") {
		super(value);
		this.app = app ?? null;
		this.sourcePath = sourcePath;
	}

	src(): string | null {
		const value = this.value.trim();
		if (/^(https?|data|app|file):/i.test(value)) return value;
		if (!this.app) return null;
		const link = LinkValue.parseFromString(this.app, value, this.sourcePath);
		const file = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(link ? link.link : value), this.sourcePath);
		return file ? this.app.vault.getResourcePath(file) : null;
	}

	renderTo(el: HTMLElement) {
		const src = this.src();
		if (src) el.createEl("img", { cls: "bases-image", attr: { src, alt: "" } });
	}
}

// Wrap a plain JavaScript value. Arrays are copied, so wrapping frontmatter
// never changes the metadata cache.
export function wrap(value: unknown): Value {
	if (value instanceof Value) return value;
	if (value === null || value === undefined) return NullValue.value;
	if (typeof value === "string") return new StringValue(value);
	if (typeof value === "number") return new NumberValue(value);
	if (typeof value === "boolean") return new BooleanValue(value);
	if (value instanceof Date) return new DateValue(value);
	if (value instanceof RegExp) return new RegExpValue(value);
	if (Array.isArray(value)) return new ListValue([...value]);
	if (typeof value === "object") return new ObjectValue(value as Record<string, unknown>);
	return new StringValue(String(value));
}

// The type names isType() accepts: the value's own `type` and those of the
// classes it extends, so a link is also a string.
export function valueTypes(value: Value): string[] {
	const types: string[] = [];
	for (let c: any = value.constructor; c && c !== Value; c = Object.getPrototypeOf(c)) {
		if (Object.hasOwn(c, "type") && !types.includes(c.type)) types.push(c.type);
	}
	return types;
}
