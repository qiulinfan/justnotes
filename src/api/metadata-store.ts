import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type { CacheItem, CachedMetadata, Pos } from "./metadata";

// What the metadata cache keeps between runs for one note: the parse of the
// note's text when it had this mtime and size.
export interface StoredMetadata {
	mtime: number;
	size: number;
	cache: CachedMetadata;
}

export interface MetadataStore {
	// The entries saved by an earlier run, or null when there are none usable.
	load(): Promise<Map<string, StoredMetadata> | null>;
	// Replaces the saved entries.
	save(entries: Map<string, StoredMetadata>): Promise<void>;
}

// Bumped whenever parseMetadata's output changes for some text, so caches
// written by an older parser are dropped (test/metadata-store.test.ts pins
// the parser's output for a fixture and fails until both are updated).
export const METADATA_CACHE_VERSION = 1;

// A JSON value that reads back exactly as it was written: plain objects and
// arrays of strings, finite numbers, booleans and null. Anything else (an
// undefined property, Infinity, a Date or binary from YAML) would come back
// changed, so such a note is parsed again instead of cached.
function exactJson(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) if (!(i in value) || !exactJson(value[i])) return false;
		return true;
	}
	if (typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const key of Object.keys(value)) if (key === "__proto__" || !exactJson((value as Record<string, unknown>)[key])) return false;
	return true;
}

// Positions are most of a note's metadata; stored as six numbers they take a
// third of the space and parse in a third of the time. Only the fields that
// hold positions are packed: frontmatter is the note's own data.
type Packed = Record<string, unknown>;
const POSITIONED = ["headings", "links", "embeds", "tags", "sections", "listItems", "footnotes", "footnoteRefs", "referenceLinks"] as const;
const packPos = (p: Pos) => [p.start.line, p.start.col, p.start.offset, p.end.line, p.end.col, p.end.offset];
const unpackPos = (a: number[]): Pos => ({ start: { line: a[0], col: a[1], offset: a[2] }, end: { line: a[3], col: a[4], offset: a[5] } });

function pack(cache: CachedMetadata): Packed {
	const out: Packed = { ...cache };
	if (cache.frontmatterPosition) out.frontmatterPosition = packPos(cache.frontmatterPosition);
	for (const key of POSITIONED) {
		const items = cache[key] as CacheItem[] | undefined;
		if (items) out[key] = items.map((item) => ({ ...item, position: packPos(item.position) }));
	}
	if (cache.blocks) out.blocks = Object.fromEntries(Object.entries(cache.blocks).map(([id, block]) => [id, { ...block, position: packPos(block.position) }]));
	return out;
}

function unpack(packed: Packed): CachedMetadata {
	if (packed.frontmatterPosition) packed.frontmatterPosition = unpackPos(packed.frontmatterPosition as number[]);
	for (const key of POSITIONED) {
		const items = packed[key] as { position: unknown }[] | undefined;
		if (items) for (const item of items) item.position = unpackPos(item.position as number[]);
	}
	if (packed.blocks) for (const block of Object.values(packed.blocks as Record<string, { position: unknown }>)) block.position = unpackPos(block.position as number[]);
	return packed as CachedMetadata;
}

// The cache of one vault as a file in the app's profile (never in the vault):
// a header line, then one JSON line per note. The lines read at startup are
// kept for the startup save (at most 10 s), which copies those of unchanged
// notes back as they were; later saves serialize every note.
export class FileMetadataStore implements MetadataStore {
	#lines: WeakMap<CachedMetadata, { mtime: number; size: number; line: string }> | null = null;

	constructor(
		readonly file: string,
		readonly vaultPath: string,
	) {}

	// The cache file for a vault under a profile folder.
	// The app and the offline CLI may spell the vault's path differently
	// (a symlinked folder, /tmp and /private/tmp), so it is keyed by real path.
	static forVault(profile: string, vaultPath: string) {
		let real = nodePath.resolve(vaultPath);
		try {
			real = fs.realpathSync(real);
		} catch {}
		// node:crypto, not Bun.hash: the app's renderer runs this too.
		const id = createHash("sha1").update(real).digest("hex").slice(0, 16);
		return new FileMetadataStore(nodePath.join(profile, "metadata-cache", `${id}.jsonl`), real);
	}

	async load() {
		let text: string;
		try {
			text = await fs.promises.readFile(this.file, "utf8");
		} catch {
			return null;
		}
		const lines = text.split("\n");
		try {
			const header = JSON.parse(lines[0]);
			if (header?.version !== METADATA_CACHE_VERSION || header.vault !== this.vaultPath) return null;
		} catch {
			return null;
		}
		const out = new Map<string, StoredMetadata>();
		const kept = new WeakMap<CachedMetadata, { mtime: number; size: number; line: string }>();
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			try {
				const [path, mtime, size, packed] = JSON.parse(line);
				if (typeof path !== "string" || typeof mtime !== "number" || typeof size !== "number" || !packed || typeof packed !== "object") continue;
				const cache = unpack(packed);
				out.set(path, { mtime, size, cache });
				kept.set(cache, { mtime, size, line });
			} catch {}
		}
		this.#lines = kept;
		// The startup save comes 3 s after the index; a start that needs none
		// lets the lines go.
		const release = setTimeout(() => {
			if (this.#lines === kept) this.#lines = null;
		}, 10_000);
		(release as { unref?: () => void }).unref?.();
		return out;
	}

	async save(entries: Map<string, StoredMetadata>) {
		const kept = this.#lines;
		this.#lines = null;
		const parts = [JSON.stringify({ version: METADATA_CACHE_VERSION, vault: this.vaultPath })];
		for (const [path, { mtime, size, cache }] of entries) {
			const known = kept?.get(cache);
			if (known && known.mtime === mtime && known.size === size && known.line.startsWith(`[${JSON.stringify(path)},`)) {
				parts.push(known.line);
				continue;
			}
			const packed = pack(cache);
			if (exactJson(packed)) parts.push(JSON.stringify([path, mtime, size, packed]));
		}
		await fs.promises.mkdir(nodePath.dirname(this.file), { recursive: true });
		// Written beside and renamed over, so a crash never leaves half a file.
		const tmp = `${this.file}.${process.pid}.tmp`;
		await fs.promises.writeFile(tmp, `${parts.join("\n")}\n`);
		await fs.promises.rename(tmp, this.file);
	}
}
