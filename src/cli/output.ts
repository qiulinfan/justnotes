import YAML from "yaml";
import type { CliData } from "../api/plugin";
import { EXIT_FAILURE, EXIT_USAGE } from "./protocol";

// What a built-in command returns: its data, printed as JSON for --json or
// format=json, and the text printed otherwise.
export interface Result {
	data: unknown;
	text: string;
}

export function result(data: unknown, text?: string): Result {
	return { data, text: text ?? (typeof data === "string" ? data : YAML.stringify(data).trimEnd()) };
}

// A failure the command reports with a status: 2 for a command line that
// cannot run (unknown names, bad values), 1 for everything else.
export class CliError extends Error {
	constructor(
		message: string,
		readonly code = EXIT_FAILURE,
	) {
		super(message);
	}
}

export const usage = (message: string) => new CliError(message, EXIT_USAGE);

// Thrown when reading the vault folder cannot answer (the active file, open
// editors, writes): the command then asks the app, starting it if needed.
export class NeedsApp extends Error {
	constructor(
		readonly why: string,
		readonly hint = "",
	) {
		super(why);
	}
}

export function wantsJson(params: CliData) {
	return params.json === "true" || params.format === "json";
}

export function render(out: Result, params: CliData) {
	return wantsJson(params) ? JSON.stringify(out.data, null, 2) : out.text;
}

export type Row = Record<string, unknown>;

const cell = (value: unknown) => (value == null ? "" : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value));
const tsvField = (s: string) => s.replace(/[\t\r\n]+/g, " ");
const csvField = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const mdField = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

export interface ListOptions {
	columns: string[];
	// The default format, and the formats the command takes besides json.
	format?: string;
	formats?: string[];
	// The text format's line for a row, when the command has one.
	text?: (row: Row) => string;
}

const LIST_FORMATS = ["tsv", "csv", "md", "yaml", "paths"];

// A list of rows in the format asked for: tsv (no header, for cut and awk),
// csv and md (with a header), yaml, paths (the first column) or json; total
// prints the count instead.
export function list(params: CliData, rows: Row[], options: ListOptions): Result {
	if (params.total === "true") return result({ total: rows.length }, String(rows.length));
	const format = params.json === "true" ? "json" : (params.format ?? options.format ?? "tsv");
	const formats = [...(options.formats ?? LIST_FORMATS), ...(options.text ? ["text"] : [])];
	if (format !== "json" && !formats.includes(format)) throw usage(`format must be one of: ${[...formats, "json"].join(", ")}`);
	const { columns } = options;
	const values = (row: Row) => columns.map((c) => cell(row[c]));
	let text: string;
	switch (format) {
		case "text":
			text = rows.map(options.text!).join("\n");
			break;
		case "csv":
			text = [columns, ...rows.map(values)].map((r) => r.map(csvField).join(",")).join("\n");
			break;
		case "md":
			text =
				columns.length === 1
					? rows.map((row) => `- ${cell(row[columns[0]])}`).join("\n")
					: [columns, columns.map(() => "---"), ...rows.map(values)].map((r) => `| ${r.map(mdField).join(" | ")} |`).join("\n");
			break;
		case "yaml":
			text = rows.length ? YAML.stringify(rows).trimEnd() : "";
			break;
		case "paths":
			text = rows.map((row) => cell(row[columns[0]])).join("\n");
			break;
		case "json":
			text = JSON.stringify(rows, null, 2);
			break;
		default:
			text = rows.map((row) => values(row).map(tsvField).join("\t")).join("\n");
	}
	return { data: rows, text };
}

// key  value lines, as Obsidian prints file info.
export function keyValues(data: Row): Result {
	const width = Math.max(...Object.keys(data).map((k) => k.length));
	return { data, text: Object.entries(data).map(([k, v]) => `${k.padEnd(width)}  ${cell(v)}`).join("\n") };
}

export function intParam(params: CliData, key: string, fallback: number, min = 0): number {
	const raw = params[key];
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min) throw usage(`${key} must be a whole number${min ? ` of at least ${min}` : ""}`);
	return n;
}

export function oneOf<T extends string>(params: CliData, key: string, values: readonly T[], fallback: T): T {
	const raw = params[key];
	if (raw === undefined) return fallback;
	if (!(values as readonly string[]).includes(raw)) throw usage(`${key} must be one of: ${values.join(", ")}`);
	return raw as T;
}

export const on = (params: CliData, key: string) => params[key] === "true";
