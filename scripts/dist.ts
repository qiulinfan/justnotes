// `bun scripts/dist.ts <electron-builder options>`: builds and packages with
// the version builds carry (JUSTNOTES_VERSION, else scripts/version.ts),
// which goes into the package's package.json (what app.getVersion reads)
// and the artifacts' names. package.json itself is not changed.
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { appVersion } from "./version";

const root = path.resolve(import.meta.dir, "..");
const version = process.env.JUSTNOTES_VERSION || appVersion();
const env = { ...process.env, JUSTNOTES_VERSION: version };

function run(cmd: string, args: string[]) {
	const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit", env });
	if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`justnotes ${version}`);
run("bun", ["run", "build"]);
run("node", ["node_modules/electron-builder/cli.js", ...process.argv.slice(2), "--publish", "never", `-c.extraMetadata.version=${version}`]);
