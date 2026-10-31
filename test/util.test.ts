import { describe, expect, test } from "bun:test";
import { normalizePath } from "../src/api/util";

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
