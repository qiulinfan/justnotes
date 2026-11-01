// `bun scripts/version.ts` prints the version a build carries, counted from
// the newest version tag (vMAJOR.MINOR.PATCH) the commit descends from: each
// commit after the tag adds one to the patch, and past 80 the patch rolls
// over into the next minor (81 commits after v0.1.0 is 0.2.0). A new major or
// minor is set by hand by tagging its commit (v0.1.0 marks a557f2e, the first
// build published). A shallow clone would miss the tag and the commits, so it
// is refused (CI checks out with fetch-depth 0); without git or a tag the
// version is package.json's.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
export const PATCH_MAX = 80;

// The version `commits` commits after the tag `tag`.
export function versionFrom(tag: string, commits: number): string {
	const [major, minor, patch] = tag.replace(/^v/, "").split(".").map(Number);
	const total = patch + commits;
	return `${major}.${minor + Math.floor(total / (PATCH_MAX + 1))}.${total % (PATCH_MAX + 1)}`;
}

export function appVersion(): string {
	const fallback: string = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
	const shallow = git("rev-parse", "--is-shallow-repository");
	if (shallow.status !== 0) return fallback;
	if (shallow.stdout.trim() === "true") throw new Error("A shallow clone cannot count from its version tag: fetch the whole history and tags");
	const described = /^(v\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/.exec(git("describe", "--tags", "--long", "--match", "v[0-9]*.[0-9]*.[0-9]*").stdout.trim());
	return described ? versionFrom(described[1], Number(described[2])) : fallback;
}

if (import.meta.main) console.log(appVersion());
