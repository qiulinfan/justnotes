import type { App } from "./app";
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
