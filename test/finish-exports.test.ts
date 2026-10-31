import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import * as obsidian from "../src/api/index";

// Plugins require("obsidian") and get Obsidian's runtime API: every value its
// typings export exists, and no justnotes internal is there for a plugin to
// come to depend on.
describe("the obsidian module", () => {
	test("has exactly the values obsidian.d.ts exports", async () => {
		const typings = await Bun.file(path.join(import.meta.dir, "../node_modules/obsidian/obsidian.d.ts")).text();
		const declared = new Set(
			Array.from(typings.matchAll(/^export (?:declare )?(?:abstract class|class|function|const|let|var|enum|namespace) ([\w$]+)/gm), (m) => m[1]),
		);
		const runtime = new Set(Object.keys(obsidian));
		expect([...declared].filter((name) => !runtime.has(name)).sort()).toEqual([]);
		expect([...runtime].filter((name) => !declared.has(name)).sort()).toEqual([]);
	});
});
