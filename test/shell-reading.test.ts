import { describe, expect, test } from "bun:test";
import { toggledTask } from "../src/api/markdown";

// A checkbox click in the reading view rewrites one character of the task's
// line; the wrong column would corrupt the note.
describe("toggledTask", () => {
	const toggle = (line: string) => {
		const task = toggledTask(line);
		return task && line.slice(0, task.ch) + task.status + line.slice(task.ch + 1);
	};

	test("an open task is ticked and any other status opens again", () => {
		expect(toggle("- [ ] buy milk")).toBe("- [x] buy milk");
		expect(toggle("- [x] buy milk")).toBe("- [ ] buy milk");
		expect(toggle("- [/] half done")).toBe("- [ ] half done");
	});

	test("ordered, nested and quoted tasks keep their markers", () => {
		expect(toggle("  12) [ ] step")).toBe("  12) [x] step");
		expect(toggle("> > * [x] quoted")).toBe("> > * [ ] quoted");
	});

	test("lines that are no task are left alone", () => {
		expect(toggledTask("[ ] not in a list")).toBeNull();
		expect(toggledTask("- [] empty box")).toBeNull();
		expect(toggledTask("-[ ] no space")).toBeNull();
	});
});
