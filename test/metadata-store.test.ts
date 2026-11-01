import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MetadataCache, parseMetadata } from "../src/api/metadata";
import { FileMetadataStore, METADATA_CACHE_VERSION } from "../src/api/metadata-store";
import { Vault } from "../src/api/vault";

const dirs: string[] = [];
const vaults: Vault[] = [];

function tempDir(prefix: string) {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
}

function makeVault(files: Record<string, string>) {
	const dir = tempDir("justnotes-store-vault-");
	for (const [p, text] of Object.entries(files)) write(dir, p, text);
	return dir;
}

function write(dir: string, p: string, text: string) {
	fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
	fs.writeFileSync(path.join(dir, p), text);
}

// One run of the app: a fresh Vault and MetadataCache on the folder, with the
// profile's store; `reads` lists the files the start read.
async function start(dir: string, profile: string) {
	const vault = new Vault(dir);
	vaults.push(vault);
	const cache = new MetadataCache(vault);
	cache.useStore(FileMetadataStore.forVault(profile, dir));
	await vault.load();
	const reads: string[] = [];
	const read = vault.adapter.read.bind(vault.adapter);
	spyOn(vault.adapter, "read").mockImplementation((p: string) => {
		reads.push(p);
		return read(p);
	});
	await cache.initialize();
	return { vault, cache, reads };
}

// Ends a run: the store holds what the run parsed, as after the debounced save.
async function stop(run: { vault: Vault; cache: MetadataCache }) {
	await run.cache.saveStore();
	run.vault.close();
}

const meta = (cache: MetadataCache, vault: Vault, p: string) => cache.getFileCache(vault.getFileByPath(p)!);

afterEach(() => {
	for (const v of vaults.splice(0)) v.close();
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("metadata cache store", () => {
	test("a second start takes unchanged notes from the store, unread, with the same metadata and links", async () => {
		const dir = makeVault({
			"a.md": "---\ntags: [x]\naliases: [Alpha]\n---\n# Head\n\nSee [[b]] and [[missing]] #tag\n\n- [ ] task ^blk\n",
			"sub/b.md": "![[a#Head]]\n\n```\n[[not a link]]\n```\n",
		});
		const profile = tempDir("justnotes-store-profile-");
		const first = await start(dir, profile);
		expect(first.reads.sort()).toEqual(["a.md", "sub/b.md"]);
		const before = { a: meta(first.cache, first.vault, "a.md"), b: meta(first.cache, first.vault, "sub/b.md"), resolved: first.cache.resolvedLinks, unresolved: first.cache.unresolvedLinks };
		await stop(first);

		const second = await start(dir, profile);
		expect(second.reads).toEqual([]);
		expect(meta(second.cache, second.vault, "a.md")).toEqual(before.a);
		expect(meta(second.cache, second.vault, "sub/b.md")).toEqual(before.b);
		expect(second.cache.resolvedLinks).toEqual(before.resolved);
		expect(second.cache.unresolvedLinks).toEqual(before.unresolved);
		expect(second.cache.getBacklinksForFile(second.vault.getFileByPath("a.md")!).keys()).toEqual(["sub/b.md"]);
	});

	test("notes edited, added or deleted outside the app while it was closed are indexed again", async () => {
		const dir = makeVault({ "a.md": "# One\n", "b.md": "[[a]]\n", "gone.md": "[[a]]\n" });
		const profile = tempDir("justnotes-store-profile-");
		await stop(await start(dir, profile));

		// Same size, new text: only the mtime tells. And a size change.
		write(dir, "a.md", "# Two\n");
		const later = new Date(Date.now() + 5000);
		fs.utimesSync(path.join(dir, "a.md"), later, later);
		write(dir, "b.md", "[[a]] [[new]]\n");
		write(dir, "new.md", "# New\n");
		fs.rmSync(path.join(dir, "gone.md"));

		const run = await start(dir, profile);
		expect(run.reads.sort()).toEqual(["a.md", "b.md", "new.md"]);
		expect(meta(run.cache, run.vault, "a.md")?.headings?.map((h) => h.heading)).toEqual(["Two"]);
		expect(run.cache.resolvedLinks["b.md"]).toEqual({ "a.md": 1, "new.md": 1 });
		expect(run.cache.getCache("gone.md")).toBeNull();
		await stop(run);

		// The store now holds the new state: nothing to read.
		const again = await start(dir, profile);
		expect(again.reads).toEqual([]);
		expect(meta(again.cache, again.vault, "a.md")?.headings?.map((h) => h.heading)).toEqual(["Two"]);
		expect(again.cache.getCache("gone.md")).toBeNull();
	});

	test("a store from another parser version, or a corrupt one, is ignored", async () => {
		const dir = makeVault({ "a.md": "# One\n" });
		const profile = tempDir("justnotes-store-profile-");
		await stop(await start(dir, profile));
		const store = FileMetadataStore.forVault(profile, dir);
		const lines = fs.readFileSync(store.file, "utf8").split("\n");
		const header = JSON.parse(lines[0]);

		fs.writeFileSync(store.file, [JSON.stringify({ ...header, version: METADATA_CACHE_VERSION - 1 }), ...lines.slice(1)].join("\n"));
		expect((await start(dir, profile)).reads).toEqual(["a.md"]);

		fs.writeFileSync(store.file, `${lines[0]}\n{not json\n`);
		const run = await start(dir, profile);
		expect(run.reads).toEqual(["a.md"]);
		expect(meta(run.cache, run.vault, "a.md")?.headings?.[0].heading).toBe("One");
	});

	// YAML gives values JSON cannot carry (.inf); such a note is parsed on
	// every start rather than restored changed.
	test("a note whose metadata JSON would change is not stored", async () => {
		const dir = makeVault({ "inf.md": "---\nx: .inf\n---\n", "plain.md": "# P\n" });
		const profile = tempDir("justnotes-store-profile-");
		await stop(await start(dir, profile));
		const run = await start(dir, profile);
		expect(run.reads).toEqual(["inf.md"]);
		expect(meta(run.cache, run.vault, "inf.md")?.frontmatter?.x).toBe(Number.POSITIVE_INFINITY);
	});

	test("a start that parsed notes saves the store a few seconds later; a read-only store (the offline CLI) is never written", async () => {
		const dir = makeVault({ "a.md": "# A\n" });
		const profile = tempDir("justnotes-store-profile-");
		const store = FileMetadataStore.forVault(profile, dir);
		await start(dir, profile);

		const offlineProfile = tempDir("justnotes-store-profile-");
		const offline = new Vault(dir);
		vaults.push(offline);
		const offlineCache = new MetadataCache(offline);
		offlineCache.useStore(FileMetadataStore.forVault(offlineProfile, dir), false);
		await offline.load();
		await offlineCache.initialize();

		expect(fs.existsSync(store.file)).toBe(false);
		await Bun.sleep(3300);
		expect(fs.readFileSync(store.file, "utf8")).toContain('"a.md"');
		expect(fs.existsSync(path.join(offlineProfile, "metadata-cache"))).toBe(false);
	}, 10000);

	test("a save after changes holds them: an edited note's new parse, a renamed note under its new path", async () => {
		const dir = makeVault({ "a.md": "# A\n", "b.md": "# B\n" });
		const profile = tempDir("justnotes-store-profile-");
		const run = await start(dir, profile);
		await run.vault.modify(run.vault.getFileByPath("a.md")!, "# A2\n");
		await run.vault.rename(run.vault.getFileByPath("b.md")!, "c.md");
		await Bun.sleep(50);
		await stop(run);
		const again = await start(dir, profile);
		expect(again.reads).toEqual([]);
		expect(meta(again.cache, again.vault, "a.md")?.headings?.[0].heading).toBe("A2");
		expect(meta(again.cache, again.vault, "c.md")?.headings?.[0].heading).toBe("B");
	});
});

// A stored parse is used without re-parsing, so whatever changes the parser's
// output for some text must also bump METADATA_CACHE_VERSION, or notes keep
// their old metadata until edited. This digest of the parse of a note using
// every feature changes with the output; add the new digest under the new
// version (never change an old entry).
const PARSER_DIGESTS: Record<number, string> = {
	1: "61515cc18cc0b57c",
};

test("the parser's output is the one stored caches were made with", () => {
	const note = [
		"---",
		"title: T",
		"tags: [a, b/c]",
		"aliases: x",
		"link: '[[Other|shown]]'",
		"---",
		"# Heading *one*",
		"",
		"Text [[Note#Sub|alias]] ![[img.png]] [md](Some%20Note.md) #tag/nested [^1]",
		"",
		"Setext",
		"===",
		"",
		"- item",
		"  - [x] done ^block-id",
		"1. ordered",
		"",
		"> [!note] callout",
		"> quote [[q]]",
		"",
		"```js",
		"[[no]] #no",
		"```",
		"",
		"$$",
		"[[no]]",
		"$$",
		"",
		"| a | b |",
		"| - | - |",
		"| [[t\\|u]] | 2 |",
		"",
		"<div>[[html]]</div>",
		"%% [[comment]] %%",
		"",
		"[^1]: foot [[f]]",
		"[ref]: https://example.com",
		"---",
	].join("\n");
	const digest = createHash("sha256").update(JSON.stringify(parseMetadata(note))).digest("hex").slice(0, 16);
	expect({ version: METADATA_CACHE_VERSION, digest }).toEqual({ version: METADATA_CACHE_VERSION, digest: PARSER_DIGESTS[METADATA_CACHE_VERSION] });
});
