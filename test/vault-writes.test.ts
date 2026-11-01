import { afterEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type TAbstractFile, Vault } from "../src/api/vault";

// Tests wait up to 25 s for the file watcher (FSEvents takes over 3 s on a
// loaded CI runner), past bun's 5 s default.
setDefaultTimeout(30_000);

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

async function until(check: () => boolean, ms = 25_000) {
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

	// The outside write lands after the vault's bytes are on disk but before
	// the vault has looked at the file again to take its write in.
	test("an outside write landing while the vault takes in its own write reaches 'modify' and cachedRead", async () => {
		const { vault, modified, full } = await makeVault({ "c.canvas": "{}" });
		const file = vault.getFileByPath("c.canvas")!;
		const stat = fs.promises.stat;
		let landed = false;
		const spy = spyOn(fs.promises, "stat").mockImplementation(((p: fs.PathLike, ...rest: []) => {
			if (!landed && String(p) === full("c.canvas")) {
				landed = true;
				fs.writeFileSync(full("c.canvas"), '{"outside":2}');
			}
			return stat(p, ...rest);
		}) as typeof fs.promises.stat);
		try {
			await vault.modify(file, '{"v":1}');
		} finally {
			spy.mockRestore();
		}
		expect(landed).toBe(true);
		expect(await until(() => modified.length === 2)).toBe(true);
		expect(await vault.cachedRead(file)).toBe('{"outside":2}');
	});
});

describe("Vault write order", () => {
	test("modify, process, append and binary writes of one file run in call order", async () => {
		const { vault } = await makeVault({ "n.md": "" });
		const file = vault.getFileByPath("n.md")!;
		const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
		const seen: string[] = [];
		const add = (c: string) => (d: string) => {
			seen.push(d);
			return `${d}${c}`;
		};
		await Promise.all([
			vault.modify(file, "a"),
			vault.process(file, add("b")),
			vault.append(file, "c"),
			vault.appendBinary(file, bytes("d")),
			vault.process(file, add("e")),
			vault.modifyBinary(file, bytes("f")),
			vault.append(file, "g"),
		]);
		expect(seen).toEqual(["a", "abcd"]);
		expect(await vault.read(file)).toBe("fg");
	});

	// A view saving through process cannot lose a plugin's modify that comes
	// while it holds the file: that write runs after it.
	test("a read or write started while process holds the file waits for its result", async () => {
		const { vault } = await makeVault({ "n.md": "old" });
		const file = vault.getFileByPath("n.md")!;
		expect(await vault.cachedRead(file)).toBe("old");
		let during: Promise<string>[] = [];
		let plugin: Promise<void> = Promise.resolve();
		await vault.process(file, (text) => {
			during = [vault.cachedRead(file), vault.read(file), vault.adapter.read("n.md")];
			plugin = vault.modify(file, `${text} plugin`);
			return `${text} view`;
		});
		expect(await Promise.all(during)).toEqual(["old view", "old view", "old view"]);
		await plugin;
		expect(await vault.read(file)).toBe("old plugin");
	});

	// Writing a note truncates it first; a reader must never get the empty or
	// cut-off file of a save under way, whether it started before or during it.
	test("a read during writes sees one whole text", async () => {
		const texts = ["a", "b", "c"].map((c) => c.repeat(8 << 20));
		const { vault } = await makeVault({ "big.md": texts[0] });
		const file = vault.getFileByPath("big.md")!;
		// The length of each read that got none of the texts.
		const reads: Promise<number | null>[] = [];
		const writes: Promise<void>[] = [];
		for (let i = 0; i < 30; i++) {
			if (i === 5) writes.push(vault.modify(file, texts[1]));
			if (i === 15) writes.push(vault.adapter.write("big.md", texts[2]));
			const read = i % 2 ? vault.read(file) : vault.adapter.read("big.md");
			reads.push(read.then((t) => (texts.includes(t) ? null : t.length)));
			await Bun.sleep(1);
		}
		await Promise.all(writes);
		expect((await Promise.all(reads)).filter((n) => n !== null)).toEqual([]);
		expect(await vault.read(file)).toBe(texts[2]);
	});

	// A read can hang (a FIFO, a stalled network mount). Every save in the
	// vault queues behind a write that waits for it, so that write waits only
	// a while, and later writes not at all.
	test("a read that never finishes holds up writes once and only for a while", async () => {
		const { vault, full } = await makeVault({ "a.md": "a", "b.md": "b" });
		const [a, b] = [vault.getFileByPath("a.md")!, vault.getFileByPath("b.md")!];
		const readFile = fs.promises.readFile;
		const spy = spyOn(fs.promises, "readFile").mockImplementation(((p: fs.PathLike, ...rest: []) =>
			String(p) === full("a.md") ? new Promise(() => {}) : readFile(p, ...rest)) as typeof fs.promises.readFile);
		let first = 0;
		let second = 0;
		try {
			void vault.read(a);
			const start = performance.now();
			await Promise.all([vault.modify(a, "a2"), vault.modify(b, "b2")]);
			first = performance.now() - start;
			await vault.modify(a, "a3");
			second = performance.now() - start - first;
		} finally {
			spy.mockRestore();
		}
		expect(first).toBeLessThan(3000);
		expect(second).toBeLessThan(500);
		expect([fs.readFileSync(full("a.md"), "utf8"), fs.readFileSync(full("b.md"), "utf8")]).toEqual(["a3", "b2"]);
	});
});
