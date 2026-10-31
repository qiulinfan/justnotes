import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { applyOverlay } from "../src/api/plugins";

installLanguageExtensions();

// justnotes never writes community-plugins.json; the Community plugins toggles
// persist an overlay that applies on top of it at startup.
describe("enabled plugins", () => {
	test("the user's choices apply over community-plugins.json, which keeps its order", () => {
		expect(applyOverlay(["a", "b", "c"], { enabled: ["d", "a"], disabled: ["b"] })).toEqual(["a", "c", "d"]);
	});
});
