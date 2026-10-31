import { describe, expect, test } from "bun:test";
import { normalizePath, prepareFuzzySearch } from "../src/api/util";

// The command palette and every FuzzySuggestModal sort by this score: typing a
// command's own words must put that command first.
describe("prepareFuzzySearch", () => {
	test("prefers a later run of whole words over an early scattered match", () => {
		const search = prepareFuzzySearch("qa new");
		const exact = search("QuickAdd: QA New");
		const scattered = search("QuickAdd: New note from template");
		expect(exact?.matches).toEqual([
			[10, 12],
			[13, 16],
		]);
		expect(exact!.score).toBeGreaterThan(scattered!.score);
	});
});

// Plugins pass user-typed paths through normalizePath before every vault call;
// a wrong result opens or creates the wrong file.
describe("normalizePath", () => {
	test("collapses slashes, strips the edges and converts backslashes", () => {
		expect(normalizePath("//a\\b//c/")).toBe("a/b/c");
	});

	test("an empty path is the vault root", () => {
		expect(normalizePath("")).toBe("/");
	});

	test("replaces non-breaking spaces, which break file lookups", () => {
		expect(normalizePath("a b")).toBe("a b");
	});
});
