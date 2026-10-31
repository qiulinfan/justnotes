import { expect, test } from "bun:test";
import { readInOrder } from "../src/api/read-in-order";
import type { TFile, Vault } from "../src/api/vault";

// A vault whose reads finish in reverse order of starting, counting how many
// are under way at once.
function slowVault(fail?: string) {
	let inFlight = 0;
	let most = 0;
	const vault = {
		async cachedRead(file: TFile) {
			inFlight++;
			most = Math.max(most, inFlight);
			await Bun.sleep(20 - Number(file.path) * 2);
			inFlight--;
			if (file.path === fail) throw new Error(`cannot read ${file.path}`);
			return `text ${file.path}`;
		},
	} as unknown as Vault;
	return { vault, most: () => most };
}

const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: String(i) }) as TFile);

test("texts come in the order given, with no more reads under way than asked", async () => {
	const { vault, most } = slowVault();
	const got: string[] = [];
	for await (const [file, text] of readInOrder(vault, files(8), 3)) got.push(`${file.path}:${text}`);
	expect(got).toEqual(files(8).map((f) => `${f.path}:text ${f.path}`));
	expect(most()).toBe(3);
});

test("a failed read throws when its file comes up, after the ones before it", async () => {
	const { vault } = slowVault("5");
	const unhandled: unknown[] = [];
	const onUnhandled = (err: unknown) => unhandled.push(err);
	process.on("unhandledRejection", onUnhandled);
	const got: string[] = [];
	let error: unknown = null;
	try {
		for await (const [file] of readInOrder(vault, files(8), 4)) got.push(file.path);
	} catch (err) {
		error = err;
	}
	await Bun.sleep(50);
	process.off("unhandledRejection", onUnhandled);
	expect(got).toEqual(["0", "1", "2", "3", "4"]);
	expect(String(error)).toContain("cannot read 5");
	expect(unhandled).toEqual([]);
});
