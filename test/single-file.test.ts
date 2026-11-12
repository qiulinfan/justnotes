import { describe, expect, test } from "bun:test";
import { singleFileLayout } from "../src/renderer/single-file";

describe("a file window's layout", () => {
	const outlineCollapsed = (name: string) => !!singleFileLayout(name).right.collapsed;

	test("a note has its outline open beside it", () => {
		expect(outlineCollapsed("note.md")).toBe(false);
		expect(outlineCollapsed("Paper.TEX")).toBe(false);
	});

	test("a book or a PDF, with no headings to list, has it collapsed", () => {
		expect(outlineCollapsed("Book.epub")).toBe(true);
		expect(outlineCollapsed("scan.pdf")).toBe(true);
	});

	test("the file explorer starts collapsed either way", () => {
		expect(singleFileLayout("note.md").left.collapsed).toBe(true);
		expect(singleFileLayout("Book.epub").left.collapsed).toBe(true);
	});
});
