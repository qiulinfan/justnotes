import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "../src/api/app";
import { moment } from "../src/api/util";
import { TFolder, Vault } from "../src/api/vault";
import { adjacentDailyNote, dailyNote } from "../src/renderer/daily-notes";
import { findTemplatesFolder } from "../src/renderer/templates";

const open: { vault: Vault; dir: string }[] = [];
afterEach(() => {
	for (const { vault, dir } of open.splice(0)) {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function appWith(files: Record<string, string>, options: Record<string, Record<string, string>>) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-daily-")));
	for (const [p, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), text);
	}
	const vault = new Vault(dir);
	await vault.load();
	open.push({ vault, dir });
	const internalPlugins = { getPluginById: (id: string) => ({ instance: { options: options[id] ?? {} } }) };
	return { vault, app: { vault, internalPlugins } as unknown as App };
}

// The owner's APFS volume ignores case: settings naming 'daily' mean the
// folder 'Daily' on disk, as they do in Obsidian.
test("daily notes and templates find folders named in another case on a case-insensitive volume", async () => {
	const { vault, app } = await appWith(
		{ "Daily/2026-10-29.md": "29", "Daily/2026-10-31.md": "31", "Daily/2026-11-02.md": "2", "Templates/t.md": "t" },
		{ "daily-notes": { folder: "daily" }, templates: { folder: "templates" } },
	);
	if (!vault.adapter.insensitive) return;
	const today = await dailyNote(app, moment("2026-10-31", "YYYY-MM-DD"));
	expect(today.path).toBe("Daily/2026-10-31.md");
	expect(await vault.read(today)).toBe("31");
	const made = await dailyNote(app, moment("2026-11-01", "YYYY-MM-DD"));
	expect(made.path).toBe("Daily/2026-11-01.md");
	expect(adjacentDailyNote(app, today, -1)?.path).toBe("Daily/2026-10-29.md");
	expect(adjacentDailyNote(app, today, 1)?.path).toBe("Daily/2026-11-01.md");
	const templates = findTemplatesFolder(app);
	expect(templates instanceof TFolder && templates.path).toBe("Templates");
});
