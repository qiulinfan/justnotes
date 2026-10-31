import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isLaunchData, launchRequest, restartArgs } from "../src/main/launch-args";

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

// What a launch opens, read the same way for the first launch and for a
// second launch on a running profile, which hands over its arguments and
// working folder (main.ts, second-instance).
describe("launchRequest", () => {
	const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jn-launch-")));
	fs.mkdirSync(path.join(cwd, "notes"));
	fs.writeFileSync(path.join(cwd, "notes/a.md"), "");
	fs.mkdirSync(path.join(cwd, "folder.md"));
	afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

	test("vaults and files are resolved against the launch's folder; only existing Markdown files count", () => {
		const args = ["/repo", "--profile", "notes/a.md", "--vault", "notes", "notes/a.md", "missing.md", "folder.md", "obsidian://open?vault=notes&file=a", "--vault", "/abs"];
		expect(launchRequest(args, cwd)).toEqual({
			vaults: [path.join(cwd, "notes"), "/abs"],
			files: [path.join(cwd, "notes/a.md")],
			urls: ["obsidian://open?vault=notes&file=a"],
		});
	});

	test("only a well-formed hand-over replaces the argv Chromium passes along", () => {
		expect(isLaunchData({ argv: ["/app", "--vault", "/v"], cwd: "/" })).toBe(true);
		expect(isLaunchData({ argv: ["/app", 3], cwd: "/" })).toBe(false);
		expect(isLaunchData({ argv: ["/app"] })).toBe(false);
		expect(isLaunchData(null)).toBe(false);
	});
});
