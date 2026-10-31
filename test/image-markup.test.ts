import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { App } from "../src/api/app";
import { htmlImageTag, imageLink, relativeSrc } from "../src/api/attachments";
import { MetadataCache } from "../src/api/metadata";
import { Vault } from "../src/api/vault";

const open: { vault: Vault; dir: string }[] = [];

async function setup(files: string[], config: Record<string, unknown> = {}) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-img-")));
	for (const p of files) {
		fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		fs.writeFileSync(path.join(dir, p), "");
	}
	const vault = new Vault(dir);
	const metadataCache = new MetadataCache(vault);
	await vault.load();
	for (const [k, v] of Object.entries(config)) vault.setConfig(k, v);
	await metadataCache.initialize();
	open.push({ vault, dir });
	return { vault, app: { vault, metadataCache } as unknown as App };
}

afterEach(() => {
	for (const { vault, dir } of open.splice(0)) {
		vault.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// The text a pasted or dropped image becomes in the note.
describe("imageLink", () => {
	test("html: Typora's tag with the src relative to the note, spaces kept, alt the file name", async () => {
		const { vault, app } = await setup(["notes/os/note.md", "notes/os/note-assets/Pasted image 20261031120000.png", "Pasted image 1.png"]);
		const nearby = vault.getFileByPath("notes/os/note-assets/Pasted image 20261031120000.png")!;
		expect(imageLink(app, nearby, "notes/os/note.md", "html")).toBe('<img src="note-assets/Pasted image 20261031120000.png" alt="Pasted image 20261031120000" style="zoom:100%;" />');
		// The vault root attachment folder from a nested note.
		const root = vault.getFileByPath("Pasted image 1.png")!;
		expect(imageLink(app, root, "notes/os/note.md", "html")).toBe('<img src="../../Pasted image 1.png" alt="Pasted image 1" style="zoom:100%;" />');
	});

	test("wikilink and markdown follow newLinkFormat; markdown encodes spaces", async () => {
		const { vault, app } = await setup(["notes/note.md", "notes/assets/my pic.png"], { newLinkFormat: "relative" });
		const file = vault.getFileByPath("notes/assets/my pic.png")!;
		expect(imageLink(app, file, "notes/note.md", "wikilink")).toBe("![[assets/my pic.png]]");
		expect(imageLink(app, file, "notes/note.md", "markdown")).toBe("![](assets/my%20pic.png)");
	});
});

describe("htmlImageTag", () => {
	test("a quote in the name cannot end the attribute", () => {
		expect(htmlImageTag('a "b".png', 'a "b"')).toBe('<img src="a %22b%22.png" alt="a &quot;b&quot;" style="zoom:100%;" />');
	});
});

describe("relativeSrc", () => {
	test("from a note at the vault root and into a sibling folder", () => {
		expect(relativeSrc("note.md", "Assets/x.png")).toBe("Assets/x.png");
		expect(relativeSrc("a/note.md", "b/x y.png")).toBe("../b/x y.png");
	});
});
