import { describe, expect, test } from "bun:test";
import groupMenuItems from "../src/api/ui/menu";

// Each case is a menu built in a running Obsidian 1.14 and the groups it drew.
// "|" is addSeparator(); "Title:section" sets a section.
function layout(adds: string[], sections: string[] = []) {
	const entries = adds.map((a) => (a === "|" ? null : { title: a.split(":")[0], section: a.split(":")[1] ?? "" }));
	return groupMenuItems(entries, sections)
		.map((group) => group.map((item) => item.title).join(","))
		.join(" | ");
}

describe("groupMenuItems", () => {
	test("named sections come first in first-seen order; items without one join the open group", () => {
		expect(layout(["A", "B:x", "C", "D:y", "E:x"])).toBe("B,E | D,A,C");
	});

	test("a separator starts a new group", () => {
		expect(layout(["A", "|", "B", "C:danger", "D:action"])).toBe("C | D,A | B");
	});

	test("leading, trailing and repeated separators draw nothing", () => {
		expect(layout(["|", "A", "|", "|", "B", "|"])).toBe("A | B");
	});

	test("addSections fixes the order; other sections follow it, even after danger", () => {
		expect(layout(["D:danger", "Z:zzz", "N", "A:action", "O:open", "T:title"], ["title", "open", "action", "danger"])).toBe("T | O | A | D | Z,N");
		expect(layout(["O:open", "A:action", "D:danger", "P:plugin", "Q:plugin"], ["open", "action", "danger"])).toBe("O | A | D | P,Q");
	});
});
