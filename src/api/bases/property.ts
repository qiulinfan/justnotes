// Bases property ids: `note.status`, `file.name`, `formula.price`.
export type BasesPropertyType = "note" | "formula" | "file";
export type BasesPropertyId = `${BasesPropertyType}.${string}`;

export interface BasesProperty {
	type: BasesPropertyType;
	name: string;
}

const TYPES = ["note", "formula", "file"];

// Split at the first dot, so `note.a.b` names the property `a.b`. A bare name
// is a note property, as it is everywhere in a .base file.
export function parsePropertyId(propertyId: BasesPropertyId): BasesProperty {
	const i = propertyId.indexOf(".");
	const type = propertyId.slice(0, i);
	if (i > 0 && TYPES.includes(type)) return { type: type as BasesPropertyType, name: propertyId.slice(i + 1) };
	return { type: "note", name: propertyId };
}

// The id a property reference in a .base file stands for: `status` is
// `note.status`; anything empty or non-string is no property.
export function normalizePropertyId(value: unknown): BasesPropertyId | null {
	if (typeof value !== "string") return null;
	const id = value.trim();
	if (!id) return null;
	const i = id.indexOf(".");
	if (i > 0 && TYPES.includes(id.slice(0, i))) return i < id.length - 1 ? (id as BasesPropertyId) : null;
	return `note.${id}`;
}

// The file properties every vault file has, with the names Obsidian shows for them.
export const FILE_PROPERTIES: Record<string, string> = {
	name: "file name",
	basename: "file base name",
	path: "file path",
	folder: "folder",
	ext: "file extension",
	size: "file size",
	ctime: "created time",
	mtime: "modified time",
	tags: "file tags",
	links: "file links",
	embeds: "file embeds",
	backlinks: "backlinks",
	properties: "file properties",
	file: "file",
};
