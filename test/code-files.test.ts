import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isTextFile } from "../src/api/code-files";

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "justnotes-code-files-"));
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

const file = async (name: string, data: string | Uint8Array) => {
	const p = path.join(dir, name);
	await Bun.write(p, data);
	return p;
};

// A file of a kind no view claims opens in the code view when it is text and
// in the system's default app otherwise, where a save could not write text
// back over binary data (macOS answered an orphaned plugin's JSON board with
// "There is no application set to open the document").
describe("which unknown files open as text", () => {
	test("a plugin's JSON board is text; binary data with NUL bytes and invalid UTF-8 is not", async () => {
		expect(await isTextFile(await file("白板.yoloboard", '{\n  "version": 1,\n  "nodes": []\n}\n'))).toBe(true);
		expect(await isTextFile(await file("a.bin", new Uint8Array([0x7b, 0x00, 0x01, 0x02])))).toBe(false);
		expect(await isTextFile(await file("latin1.dat", new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x21])))).toBe(false);
	});

	test("a multibyte character cut by the 8 KB sample still counts as text", async () => {
		// "中" is three bytes; 8191 ASCII bytes put its first byte last in the sample.
		expect(await isTextFile(await file("cut.board", `${"a".repeat(8191)}中文`))).toBe(true);
	});
});
