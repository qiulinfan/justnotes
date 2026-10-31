import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TAbstractFile, Vault } from "../src/api/vault";

const open: { vault: Vault; dir: string }[] = [];

async function makeVault(files: Record<string, string>) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-writes-")));
	for (const [p, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, p), text);
	const vault = new Vault(dir);
	await vault.load();
	open.push({ vault, dir });
	const modified: string[] = [];
	vault.on("modify", (f: TAbstractFile) => modified.push(f.path));
	const raw: string[] = [];
	vault.on("raw", (p: string) => raw.push(p));
	return { vault, modified, raw, full: (p: string) => path.join(dir, p) };
}

afterEach(() => {
	for (const { vault, dir } of open.splice(0)) {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

async function until(check: () => boolean, ms = 3000) {
	for (let t = 0; t < ms && !check(); t += 20) await Bun.sleep(20);
	return check();
}

describe("Vault and outside changes", () => {
	// The watcher also reports the vault's own writes.
	test("a vault write fires one 'modify', and the watcher's report of it adds none", async () => {
		const { vault, modified, raw } = await makeVault({ "n.md": "old" });
		const seen = raw.length;
		await vault.modify(vault.getFileByPath("n.md")!, "new text");
		expect(modified).toEqual(["n.md"]);
		expect(await until(() => raw.slice(seen).includes("n.md"))).toBe(true);
		await Bun.sleep(300);
		expect(modified).toEqual(["n.md"]);
	});

	// git or another editor may write the file just after a save; the text is
	// the same length, so only its modification time tells the writes apart.
	test("an outside write right after a vault write reaches 'modify' and reads", async () => {
		const { vault, modified, full } = await makeVault({ "n.md": "old" });
		const file = vault.getFileByPath("n.md")!;
		await vault.modify(file, "a");
		fs.writeFileSync(full("n.md"), "b");
		expect(await until(() => modified.length === 2)).toBe(true);
		expect(await vault.read(file)).toBe("b");
		expect(await vault.cachedRead(file)).toBe("b");
	});
});
