import type { App } from "../app";
import type { TFile } from "../vault";
import { type Node, parseExpression } from "./expression";
import { PrimitiveValue } from "./values";

export interface NewNote {
	folder?: string;
	frontmatter: Record<string, unknown>;
	tags: string[];
}

// What a new note needs to match the base: `status == "todo"` sets status,
// file.hasTag("x") adds a tag, and file.inFolder("x") picks the folder. Only
// conditions every match must meet count, so `or` and `not` imply nothing.
export function impliedByFilters(filters: unknown[], out: NewNote) {
	for (const filter of filters) {
		if (typeof filter === "string") {
			const parsed = parseExpression(filter);
			if (parsed.node) impliedByNode(parsed.node, out);
		} else if (Array.isArray(filter)) impliedByFilters(filter, out);
		else if (filter && typeof filter === "object" && "and" in filter) impliedByFilters([(filter as { and: unknown }).and].flat(), out);
	}
}

const ROOTS = ["file", "note", "formula", "this"];

function noteProperty(node: Node): string | null {
	if (node.kind === "ident" && !ROOTS.includes(node.name)) return node.name;
	if (node.kind === "member" && node.object.kind === "ident" && node.object.name === "note") return node.name;
	return null;
}

function impliedByNode(node: Node, out: NewNote) {
	if (node.kind === "binary" && node.op === "&&") {
		impliedByNode(node.left, out);
		impliedByNode(node.right, out);
	} else if (node.kind === "binary" && node.op === "==") {
		const name = noteProperty(node.left) ?? noteProperty(node.right);
		const literal = node.left.kind === "literal" ? node.left.value : node.right.kind === "literal" ? node.right.value : null;
		if (name && literal instanceof PrimitiveValue) out.frontmatter[name] = literal.value;
	} else if (node.kind === "call" && node.callee.kind === "member" && node.callee.object.kind === "ident" && node.callee.object.name === "file") {
		const first = node.args[0];
		const arg = first?.kind === "literal" ? first.value.toString() : null;
		if (!arg) return;
		if (node.callee.name === "hasTag") out.tags.push(arg.replace(/^#/, ""));
		else if (node.callee.name === "inFolder") out.folder = arg.replace(/^\/+|\/+$/g, "");
	}
}

// A new note for a base whose filters are `filters` (the base's and the
// view's): in the folder they imply, else where new notes go from
// `sourcePath`, with the properties and tags they imply.
export async function createBaseNote(
	app: App,
	filters: unknown[],
	sourcePath: string,
	name = "Untitled",
	content = "",
	frontmatterProcessor?: (frontmatter: any, file: TFile) => void,
) {
	const implied: NewNote = { frontmatter: {}, tags: [] };
	impliedByFilters(filters, implied);
	const folder = (implied.folder && app.vault.getFolderByPath(implied.folder)) || app.fileManager.getNewFileParent(sourcePath);
	const file = await app.fileManager.createNewMarkdownFile(folder, name, content);
	if (Object.keys(implied.frontmatter).length || implied.tags.length || frontmatterProcessor) {
		await app.fileManager.processFrontMatter(file, (fm) => {
			Object.assign(fm, implied.frontmatter);
			if (implied.tags.length) fm.tags = [...new Set([...(Array.isArray(fm.tags) ? fm.tags : []), ...implied.tags])];
			frontmatterProcessor?.(fm, file);
		});
	}
	return file;
}
