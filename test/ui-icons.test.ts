import { expect, test } from "bun:test";
import { getIcon, getIconIds } from "../src/api/icons";

// Icon pickers pass whatever the user typed: an id that names an
// Object.prototype member is an unknown icon, not a crash.
test("getIcon treats Object.prototype names as unknown ids", () => {
	for (const id of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
		expect(getIcon(id)).toBeNull();
	}
});

// Icon pickers list getIconIds() and store the ids they show; Obsidian spells
// them by hyphenating where a lowercase letter meets a capital or a digit.
test("getIconIds spells Lucide names the way Obsidian lists them", () => {
	const ids = new Set(getIconIds());
	for (const id of ["lucide-arrow-down-01", "lucide-heading-1", "lucide-clock-10", "lucide-axis-3d", "lucide-alarm-clock-check"]) {
		expect(ids.has(id)).toBe(true);
	}
	expect(ids.has("lucide-arrow-down01")).toBe(false);
});
