import { describe, expect, test } from "bun:test";
import { clipboardCall } from "../src/main/ipc";

// This Electron's clipboard: asynchronous, with read() and write() of items by
// MIME type. This one keeps what is written, like the system clipboard.
class Item {
	types: string[];
	#data: Record<string, string | Blob>;
	constructor(data: Record<string, string | Blob>) {
		this.#data = data;
		this.types = Object.keys(data);
	}
	async getType(type: string) {
		const value = this.#data[type];
		if (value === undefined) throw new Error(`No ${type} on the clipboard`);
		return typeof value === "string" ? new Blob([value], { type }) : value;
	}
}

function memoryClipboard(...items: Item[]) {
	let held = items;
	return {
		clear: () => {
			held = [];
		},
		has: async (type: string) => held.some((item) => item.types.includes(type)),
		read: async () => held,
		readText: async () => {
			const item = held.find((i) => i.types.includes("text/plain"));
			return item ? (await item.getType("text/plain")).text() : "";
		},
		write: async (next: Item[]) => {
			held = next;
		},
		writeText: async (text: string) => {
			held = [new Item({ "text/plain": text })];
		},
	};
}

const call = (clipboard: ReturnType<typeof memoryClipboard>, method: string, ...args: unknown[]) => clipboardCall(clipboard as any, Item as any, method, args);

// dom.ts hands plugins Obsidian's synchronous clipboard and waits for these
// replies; latex-live reads a copied table's text and HTML.
describe("the synchronous clipboard's calls", () => {
	test("readHTML gives a copied table's HTML, and an empty string when only text was copied", async () => {
		const table = "<table><tr><td>x</td><td>y</td></tr></table>";
		expect(await call(memoryClipboard(new Item({ "text/plain": "x\ty", "text/html": table })), "readHTML")).toEqual({ value: table });
		expect(await call(memoryClipboard(new Item({ "text/plain": "x\ty" })), "readHTML")).toEqual({ value: "" });
	});

	test("an image written as PNG bytes reads back as those bytes, and as null once the clipboard holds text", async () => {
		const clipboard = memoryClipboard();
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		await call(clipboard, "writeImage", png);
		expect(await call(clipboard, "availableFormats")).toEqual({ value: ["image/png"] });
		expect(await call(clipboard, "readImage")).toEqual({ value: png });
		await call(clipboard, "writeText", "plain");
		expect(await call(clipboard, "readImage")).toEqual({ value: null });
	});

	test("a clipboard that fails, or a call it does not have, resolves with the error instead of rejecting", async () => {
		// The renderer waits on sendSync until a reply is set; a rejection would
		// leave it waiting.
		const broken = { ...memoryClipboard(), read: async () => Promise.reject(new Error("Clipboard busy")) };
		expect(await call(broken, "readHTML")).toEqual({ error: "Clipboard busy" });
		expect(await call(memoryClipboard(), "readRTF")).toEqual({ error: "clipboard.readRTF is not available" });
	});
});
