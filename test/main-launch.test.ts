import { describe, expect, test } from "bun:test";
import { restartArgs } from "../src/main/launch-args";

// `justnotes restart` relaunches with the launch's options and the vault
// windows open now; what the first launch opened must not open again.
describe("restartArgs", () => {
	test("keeps options, drops the launch's vaults, files and obsidian: URLs, and adds the open vaults", () => {
		const launch = [
			"/repo",
			"--use-mock-keychain",
			"obsidian://new?file=Inbox&content=x",
			"--vault",
			"/v/closed",
			"/v/notes/today.md",
			"--profile",
			"/tmp/profile.md",
			"--remote-debugging-port=9963",
			"Readme.markdown",
		];
		expect(restartArgs(launch, ["/v/notes", "/v/other"])).toEqual([
			"/repo",
			"--use-mock-keychain",
			"--profile",
			"/tmp/profile.md",
			"--remote-debugging-port=9963",
			"--vault",
			"/v/notes",
			"--vault",
			"/v/other",
		]);
	});
});
