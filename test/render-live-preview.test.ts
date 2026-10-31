import { describe, expect, test } from "bun:test";
import { resolveHtmlSrc } from "../src/api/markdown";

// Raw HTML images in notes written in Typora: the reading view and Live
// Preview both find them in the vault this way.
describe("resolveHtmlSrc", () => {
	const vault = new Set(["notes/Assets/a b.png", "shot.png"]);
	const resolve = (src: string) => resolveHtmlSrc(src, (path) => (vault.has(path) ? path : vault.has(`notes/${path}`) ? `notes/${path}` : null));

	test("relative paths with backslashes, ./ and %-escapes find the file", () => {
		expect(resolve("Assets\\a b.png")).toBe("notes/Assets/a b.png");
		expect(resolve("./Assets/a%20b.png")).toBe("notes/Assets/a b.png");
	});

	test("an absolute path from another machine finds the file by its name", () => {
		expect(resolve("/Users/someone/vault/shot.png")).toBe("shot.png");
		expect(resolve("C:\\Users\\someone\\Pictures\\shot.png")).toBe("shot.png");
	});

	test("URLs and anchors are not vault paths", () => {
		expect(resolve("https://example.com/shot.png")).toBeNull();
		expect(resolve("//cdn.example.com/shot.png")).toBeNull();
		expect(resolve("#shot.png")).toBeNull();
	});
});
