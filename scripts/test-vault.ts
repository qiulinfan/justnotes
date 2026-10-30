// Make a disposable copy of a vault for testing:
//   bun scripts/test-vault.ts <source-vault> <dest> [plugin-id ...]
// Copies `.obsidian` (without Obsidian's workspace state and without bulky
// plugin runtimes), Markdown files, and images up to 2 MB. When plugin ids are
// given, the copy's community-plugins.json enables only those.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const [source, dest, ...plugins] = process.argv.slice(2);
if (!source || !dest) {
	console.error("usage: bun scripts/test-vault.ts <source-vault> <dest> [plugin-id ...]");
	process.exit(1);
}

await fs.rm(dest, { recursive: true, force: true });
await fs.mkdir(dest, { recursive: true });
const src = path.resolve(source);
await $`rsync -a --exclude workspace.json --exclude workspace-mobile.json --exclude 'plugins/*/node_modules' --exclude 'plugins/yolo/runtime' --exclude 'plugins/yolo/modules' --exclude 'plugins/yolo/chatgpt-oauth' ${`${src}/.obsidian`} ${dest}/`.quiet();
await $`rsync -a --prune-empty-dirs --max-size=2m --exclude '.*/' --include '*/' --include '*.md' --include '*.png' --include '*.jpg' --include '*.jpeg' --include '*.gif' --include '*.svg' --include '*.webp' --exclude '*' ${`${src}/`} ${dest}/`.quiet();
if (plugins.length) {
	await Bun.write(path.join(dest, ".obsidian/community-plugins.json"), JSON.stringify(plugins, null, 2));
}
const count = (await $`find ${dest} -name '*.md' -not -path '*/.obsidian/*'`.quiet().text()).split("\n").filter(Boolean).length;
console.log(`${dest}: ${count} notes, plugins: ${plugins.length ? plugins.join(", ") : "as in source"}`);
