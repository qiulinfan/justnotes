import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isUpdate, macSwapScript, parseRelease, releaseCommit, windowsSwapScript, windowsArgument } from "../src/main/update-check";

const github = {
	tag_name: "main-0.1.0-4ebe64d",
	published_at: "2026-11-01T04:00:00Z",
	assets: [
		{ name: "justnotes-0.1.0-mac-arm64.dmg", browser_download_url: "", size: 1 },
		{ name: "justnotes-0.1.0-mac-arm64.zip", browser_download_url: "", size: 2 },
		{ name: "justnotes-0.1.0-mac-x64.zip", browser_download_url: "", size: 3 },
		{ name: "justnotes-0.1.0-win-x64-setup.exe", browser_download_url: "", size: 4 },
		{ name: "justnotes-0.1.0-win-x64.zip", browser_download_url: "", size: 5 },
	],
};
for (const asset of github.assets) asset.browser_download_url = `https://github.com/qiulinfan/justnotes/releases/download/${github.tag_name}/${asset.name}`;
const published = Date.parse(github.published_at);

describe("the latest release", () => {
	test("its commit comes from a main- tag only", () => {
		expect(releaseCommit("main-0.1.0-4ebe64d")).toBe("4ebe64d");
		expect(releaseCommit("v0.1.0")).toBeNull();
	});

	test("the zip for the platform and architecture", () => {
		expect(parseRelease(github, "darwin", "arm64")?.asset?.name).toBe("justnotes-0.1.0-mac-arm64.zip");
		expect(parseRelease(github, "darwin", "x64")?.asset?.name).toBe("justnotes-0.1.0-mac-x64.zip");
		expect(parseRelease(github, "win32", "x64")?.asset?.name).toBe("justnotes-0.1.0-win-x64.zip");
		expect(parseRelease(github, "linux", "x64")?.asset).toBeNull();
	});

	test("is an update when built from another commit and published after this build", () => {
		const release = parseRelease(github, "darwin", "arm64")!;
		expect(isUpdate({ commit: "1111111aaaa", time: published - 1000 }, release)).toBe(true);
		// The same commit: the installed release, or a build of that checkout.
		expect(isUpdate({ commit: "4ebe64dde749", time: published - 1000 }, release)).toBe(false);
		// Published before a local build of a commit not pushed yet.
		expect(isUpdate({ commit: "1111111aaaa", time: published + 1000 }, release)).toBe(false);
		expect(parseRelease({ ...github, tag_name: "v0.2.0" }, "darwin", "arm64")).toBeNull();
	});
	test("only this repository's release assets are accepted", () => {
		expect(parseRelease({ ...github, tag_name: "main-../../escape-1234567" }, "win32", "x64")).toBeNull();
		const foreign = {
			...github,
			assets: github.assets.map((asset) => ({
				...asset,
				browser_download_url: "https://example.com/" + asset.name,
			})),
		};
		expect(parseRelease(foreign, "win32", "x64")?.asset).toBeNull();
	});
});

describe("swap scripts", () => {
	test.skipIf(process.platform === "win32")("the macOS script swaps the staged app in and keeps quoted paths whole", () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes swap '")));
		try {
			for (const [app, marker] of [
				["installed/justnotes.app", "old"],
				["staged/justnotes.app", "new"],
			]) {
				fs.mkdirSync(path.join(dir, app, "Contents"), { recursive: true });
				fs.writeFileSync(path.join(dir, app, "Contents", "marker"), marker);
			}
			// A pid that has exited, and no relaunch; lsregister may fail on a test bundle.
			const script = macSwapScript(999999, path.join(dir, "staged/justnotes.app"), path.join(dir, "installed/justnotes.app"), null);
			spawnSync("/bin/sh", ["-c", script]);
			expect(fs.readFileSync(path.join(dir, "installed/justnotes.app/Contents/marker"), "utf8")).toBe("new");
			expect(fs.readdirSync(path.join(dir, "installed"))).toEqual(["justnotes.app"]);
			expect(fs.existsSync(path.join(dir, "staged/justnotes.app"))).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("relaunch arguments are quoted", () => {
		expect(macSwapScript(1, "/s/a.app", "/Applications/justnotes.app", ["--vault", "/x/it's here"])).toContain(`open '/Applications/justnotes.app' --args '--vault' '/x/it'\\''s here'`);
		expect(macSwapScript(1, "/s/a.app", "/Applications/justnotes.app", null)).not.toContain("open ");
		const ps = windowsSwapScript(1, "C:\\s\\app", "C:\\Users\\a\\Programs\\justnotes", ["--vault", "C:\\My Notes"]);
		expect(windowsArgument("C:\\My Notes\\")).toBe('"C:\\My Notes\\\\"');
		expect(ps).toContain(`-ArgumentList @('--vault', '"C:\\My Notes"')`);
	});
});
