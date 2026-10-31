import { describe, expect, test } from "bun:test";
import { installLanguageExtensions } from "../src/api/dom";
import { Events } from "../src/api/events";

installLanguageExtensions();

// obsidian-git turns a feature off before turning it on, offref-ing refs it
// never created; a throw there leaves the feature off.
describe("Events.offref", () => {
	test("ignores a missing ref and keeps the registered handlers", () => {
		const events = new Events();
		const calls: string[] = [];
		const ref = events.on("change", () => calls.push("change"));
		events.offref(undefined);
		events.trigger("change");
		events.offref(ref);
		events.trigger("change");
		expect(calls).toEqual(["change"]);
	});
});
