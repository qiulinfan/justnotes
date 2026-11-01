// `bun scripts/version.ts` prints the version a build carries: package.json's
// major and minor, set by hand for a big change, and as the patch the number
// of commits in the checkout's history, so every push to main counts up.
// A shallow clone would count only what it fetched, so it is refused (CI
// checks out with fetch-depth 0). Without git the patch is package.json's.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");

export function appVersion(): string {
	const base: string = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	const [major, minor, patch] = base.split(".");
	const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
	const shallow = git("rev-parse", "--is-shallow-repository");
	if (shallow.status !== 0) return `${major}.${minor}.${patch}`;
	if (shallow.stdout.trim() === "true") throw new Error("A shallow clone cannot count its commits: fetch the whole history");
	return `${major}.${minor}.${git("rev-list", "--count", "HEAD").stdout.trim()}`;
}

if (import.meta.main) console.log(appVersion());
