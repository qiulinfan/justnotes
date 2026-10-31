// Note properties edited as text in a table cell. A list is edited one item
// per line, so an item may hold a comma; a value plain text cannot show, such
// as an object, is not edited in a cell at all.
import type { FileManager } from "../file-manager";
import type { TFile } from "../vault";

const LIST_TYPES = ["multitext", "tags", "aliases"];

// Writes a cell's edit to the note's frontmatter. processFrontMatter refuses
// frontmatter that is not a map or does not parse; then the reason to show
// comes back (null when written), never an unhandled rejection.
export async function writeCell(fileManager: Pick<FileManager, "processFrontMatter">, file: TFile, edit: (frontmatter: any) => void): Promise<string | null> {
	try {
		await fileManager.processFrontMatter(file, edit);
		return null;
	} catch (err) {
		return `Could not edit ${file.path}: ${err instanceof Error ? err.message : String(err)}.`;
	}
}

export interface CellEditor {
	text: string;
	// A list, or text over several lines, is edited in a textarea.
	multiline: boolean;
	// Whether the edited text changes the value; whitespace around the text, or
	// around an item, does not count.
	changed(text: string): boolean;
	// The value to write for the edited text, given the value now in the note.
	// Undefined clears the property.
	parse(text: string, current: unknown): unknown;
}

const lines = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

const isPresent = (v: unknown) => v !== null && v !== undefined;

// A list item that one line of text shows as it is.
const fitsLine = (v: unknown) => !isPresent(v) || ((typeof v === "string" || typeof v === "number" || typeof v === "boolean") && !String(v).includes("\n"));

function listItems(raw: unknown, type: string | null): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (!isPresent(raw) || raw === "") return [];
	// A tags string holds tags separated by commas or spaces, as the cell shows them.
	if (type === "tags" && typeof raw === "string") return raw.split(/[,\s]+/).filter(Boolean);
	return [raw];
}

// The edited lines as list items. A line that still reads as an old item
// keeps that item as written, so untouched numbers and links do not turn into
// text; a new line in a list of numbers is a number.
function editList(old: unknown[], edited: string[]): unknown[] | undefined {
	const pool = old.filter(isPresent);
	const numbers = pool.length > 0 && pool.every((v) => typeof v === "number");
	const items = edited.map((line) => {
		const i = pool.findIndex((v) => String(v).trim() === line);
		if (i >= 0) return pool.splice(i, 1)[0];
		return numbers && Number.isFinite(Number(line)) ? Number(line) : line;
	});
	return items.length ? items : undefined;
}

// How a property of the given type and frontmatter value is edited, or null
// when a cell cannot edit it. A value that turned into one a cell cannot edit
// while the cell was open is kept.
export function cellEditor(raw: unknown, type: string | null): CellEditor | null {
	if (Array.isArray(raw) || LIST_TYPES.includes(type ?? "")) {
		const items = listItems(raw, type);
		if (!items.every(fitsLine)) return null;
		const text = items.filter(isPresent).map(String).join("\n");
		return {
			text,
			multiline: true,
			changed: (next) => lines(next).join("\n") !== lines(text).join("\n"),
			parse: (next, current) => {
				const old = listItems(current, type);
				return old.every(fitsLine) ? editList(old, lines(next)) : current;
			},
		};
	}
	if (isPresent(raw) && typeof raw === "object") return null;
	const text = isPresent(raw) ? String(raw) : "";
	const numeric = typeof raw === "number" || type === "number";
	return {
		text,
		multiline: text.includes("\n"),
		changed: (next) => next.trim() !== text.trim(),
		parse: (next, current) => {
			if (isPresent(current) && typeof current === "object") return current;
			const value = next.trim();
			if (!value) return undefined;
			return numeric && Number.isFinite(Number(value)) ? Number(value) : value;
		},
	};
}
