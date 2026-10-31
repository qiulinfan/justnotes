import * as nodePath from "node:path";
import type { App } from "./app";
import type { PastedImageFormat } from "./editor-settings";
import { encodePath } from "./link-encoding";
import { moment } from "./util";
import type { TFile } from "./vault";

// A file pasted or dropped from outside the app, as the vault file it
// becomes: one already in the vault (dragged from Finder out of the vault
// folder) is that file; any other is copied into the attachment folder for
// `sourcePath` (app.json's attachmentFolderPath) under a free name. A pasted
// image is named "Pasted image <time>", as in Obsidian.
export async function importFile(app: App, file: File, sourcePath: string, pasted = false): Promise<TFile> {
	const webUtils = require("electron").webUtils;
	const disk: string | undefined = webUtils?.getPathForFile?.(file);
	const base = app.vault.adapter.basePath;
	const inside = disk?.startsWith(`${base}/`) ? app.vault.getFileByPath(disk.slice(base.length + 1)) : null;
	if (inside) return inside;
	const ext = /\.([^.]+)$/.exec(file.name)?.[1] ?? file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
	const name = pasted && file.type.startsWith("image/") ? `Pasted image ${moment().format("YYYYMMDDHHmmss")}.${ext}` : file.name;
	const path = await app.fileManager.getAvailablePathForAttachment(name, sourcePath);
	return app.vault.createBinary(path, await file.arrayBuffer());
}

const IMAGE_EXTENSIONS = /^(avif|bmp|gif|jpe?g|png|svg|webp)$/i;

export function isImageFile(file: TFile) {
	return IMAGE_EXTENSIONS.test(file.extension);
}

// The vault path `filePath` as written from the note at `sourcePath`:
// relative to the note's folder, with forward slashes and spaces as they are,
// as Typora writes an image's src.
export function relativeSrc(sourcePath: string, filePath: string) {
	return nodePath.posix.relative(nodePath.posix.dirname(sourcePath || "x"), filePath);
}

// Typora's tag for a pasted image, as the owner's notes hold it. A '"' in
// the path is %-escaped (both views decode the src) and in the alt text an
// entity.
export function htmlImageTag(src: string, alt: string) {
	return `<img src="${src.replace(/"/g, "%22")}" alt="${alt.replace(/"/g, "&quot;")}" style="zoom:100%;" />`;
}

// How an image file pasted or dropped into the note at `sourcePath` is
// written, per the "Pasted and dropped images as" setting: Typora's HTML
// (src relative to the note, alt the file's name), a wikilink embed or a
// Markdown image, both with the vault's newLinkFormat.
export function imageLink(app: App, file: TFile, sourcePath: string, format: PastedImageFormat) {
	if (format === "html") return htmlImageTag(relativeSrc(sourcePath, file.path), file.basename);
	if (format === "wikilink") return `![[${app.metadataCache.fileToLinktext(file, sourcePath, true)}]]`;
	return `![](${encodePath(app.metadataCache.fileToLinktext(file, sourcePath, false))})`;
}
