import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { htmlToMarkdown } from "../src/api/util";

installLanguageExtensions();

describe("Array.prototype.remove", () => {
	test("removes every occurrence, so a handler added twice is fully unregistered", () => {
		const handler = () => {};
		const other = () => {};
		const list = [handler, other, handler];
		list.remove(handler);
		expect(list).toEqual([other]);
	});
});

describe("htmlToMarkdown", () => {
	test("keeps tables, strikethrough, highlights and task lists, with * emphasis", () => {
		const html =
			"<table><tr><th>Name</th><th>Note</th></tr><tr><td><em>a</em></td><td>x | y</td></tr></table>" +
			"<p><del>old</del> <mark>key</mark></p>" +
			'<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>';
		expect(htmlToMarkdown(html)).toBe(
			["| Name | Note |", "| --- | --- |", "| *a* | x \\| y |", "", "~~old~~ ==key==", "", "-   [x] done", "-   [ ] todo"].join("\n"),
		);
	});
});
