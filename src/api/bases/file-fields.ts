// The `file.*` properties of a vault file.
import type { App } from "../app";
import { getAllTags } from "../metadata-utils";
import type { TFile } from "../vault";
import { wrapProperty } from "./frontmatter";
import { DateValue, FileValue, LinkValue, ListValue, NumberValue, ObjectValue, StringValue, TagValue, type Value } from "./values";

// Who links to each file, inverted from metadataCache.resolvedLinks. Building
// it walks every link in the vault, so it is built on first use and dropped
// when a query reruns after a change.
const backlinkIndex = new WeakMap<App, Map<string, string[]>>();

export function invalidateLinkIndex(app: App) {
	backlinkIndex.delete(app);
}

function backlinks(app: App, file: TFile) {
	let index = backlinkIndex.get(app);
	if (!index) {
		index = new Map();
		for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
			for (const target of Object.keys(targets)) {
				const list = index.get(target);
				if (list) list.push(source);
				else index.set(target, [source]);
			}
		}
		backlinkIndex.set(app, index);
	}
	return index.get(file.path) ?? [];
}

export function frontmatterOf(app: App, file: TFile): Record<string, unknown> | null {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter;
	return fm && typeof fm === "object" ? fm : null;
}

function linkList(app: App, file: TFile, refs: { link: string; displayText?: string; original?: string }[]) {
	const seen = new Set<string>();
	const links: Value[] = [];
	for (const ref of refs) {
		if (seen.has(ref.link)) continue;
		seen.add(ref.link);
		links.push(new LinkValue(app, ref.link, file.path));
	}
	return new ListValue(links);
}

export function fileField(app: App, file: TFile, name: string): Value | undefined {
	switch (name) {
		case "name":
			return new StringValue(file.name);
		case "basename":
			return new StringValue(file.basename);
		case "path":
			return new StringValue(file.path);
		case "folder":
			return new StringValue(file.parent?.path ?? "/");
		case "ext":
			return new StringValue(file.extension);
		case "size":
			return new NumberValue(file.stat.size);
		case "ctime":
			return new DateValue(new Date(file.stat.ctime));
		case "mtime":
			return new DateValue(new Date(file.stat.mtime));
		case "tags": {
			const tags = getAllTags(app.metadataCache.getFileCache(file)) ?? [];
			const unique = new Map(tags.map((t) => [t.toLowerCase(), t]));
			return new ListValue([...unique.values()].map((t) => new TagValue(t)));
		}
		case "links": {
			const cache = app.metadataCache.getFileCache(file);
			return linkList(app, file, [...(cache?.links ?? []), ...(cache?.frontmatterLinks ?? [])]);
		}
		case "embeds":
			return linkList(app, file, app.metadataCache.getFileCache(file)?.embeds ?? []);
		case "backlinks":
			return new ListValue(
				backlinks(app, file).flatMap((path) => {
					const source = app.vault.getFileByPath(path);
					return source ? [new LinkValue(app, app.metadataCache.fileToLinktext(source, file.path, true), file.path)] : [];
				}),
			);
		case "properties":
			return new ObjectValue(frontmatterOf(app, file) ?? {}, (key, raw) => wrapProperty(app, key, raw, file.path));
		case "file":
			return new FileValue(app, file);
	}
	return undefined;
}

// file.hasLink(other): does `file` link to `target`?
export function fileLinksTo(app: App, file: TFile, target: TFile) {
	return (app.metadataCache.resolvedLinks[file.path]?.[target.path] ?? 0) > 0;
}

export function fileHasTag(app: App, file: TFile, tags: string[]) {
	const own = (getAllTags(app.metadataCache.getFileCache(file)) ?? []).map((t) => t.replace(/^#/, "").toLowerCase());
	return tags.some((tag) => {
		const want = tag.replace(/^#/, "").toLowerCase();
		return own.some((t) => t === want || t.startsWith(`${want}/`));
	});
}

export function fileInFolder(file: TFile, folder: string) {
	const want = folder.replace(/^\/+|\/+$/g, "");
	if (!want) return true;
	for (let parent = file.parent; parent; parent = parent.parent) if (parent.path === want) return true;
	return false;
}
