// Make a disposable copy of a vault for testing:
//   bun scripts/test-vault.ts <source-vault> <dest> [plugin-id ...]
// Copies `.obsidian` (without Obsidian's workspace state and without bulky
// plugin runtimes), Markdown files, Typst files with their bibliographies (for
// obsidian-tinymist), and images up to 2 MB. When plugin ids are
// given, the copy's community-plugins.json enables only those. No link in the
// copy points outside it, so nothing tested in the copy can write the source.
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
await $`rsync -a --safe-links --exclude workspace.json --exclude workspace-mobile.json --exclude 'plugins/*/node_modules' --exclude 'plugins/yolo/runtime' --exclude 'plugins/yolo/modules' --exclude 'plugins/yolo/chatgpt-oauth' ${`${src}/.obsidian`} ${dest}/`.quiet();
await $`rsync -a --safe-links --prune-empty-dirs --max-size=2m --exclude '.*/' --include '*/' --include '*.md' --include '*.typ' --include '*.bib' --include '*.png' --include '*.jpg' --include '*.jpeg' --include '*.gif' --include '*.svg' --include '*.webp' --exclude '*' ${`${src}/`} ${dest}/`.quiet();

// --safe-links drops links that leave the copy. A plugin folder can be such a
// link to the plugin's development checkout (the owner's latex-live is one);
// copy the checkout's top-level files, which hold everything Obsidian loads,
// so the plugin's saveData in the copy cannot write the real data.json.
const pluginDir = path.join(src, ".obsidian/plugins");
for (const entry of await fs.readdir(pluginDir, { withFileTypes: true }).catch(() => [])) {
	if (!entry.isSymbolicLink()) continue;
	const target = await fs.realpath(path.join(pluginDir, entry.name));
	const copy = path.join(dest, ".obsidian/plugins", entry.name);
	await fs.mkdir(copy, { recursive: true });
	for (const file of await fs.readdir(target, { withFileTypes: true })) {
		if (file.isFile() && !file.name.startsWith(".")) await fs.copyFile(path.join(target, file.name), path.join(copy, file.name));
	}
}
if (plugins.length) {
	await Bun.write(path.join(dest, ".obsidian/community-plugins.json"), JSON.stringify(plugins, null, 2));
}
const count = (await $`find ${dest} -name '*.md' -not -path '*/.obsidian/*'`.quiet().text()).split("\n").filter(Boolean).length;
console.log(`${dest}: ${count} notes, plugins: ${plugins.length ? plugins.join(", ") : "as in source"}`);
