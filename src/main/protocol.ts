import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { session } from "electron";

// Custom URL schemes for the renderer. registerSchemes runs before the app is
// ready, handleSchemes after.
export function registerSchemes() {}

// Obsidian serves its bundled libraries from the app root, and plugins address
// them root-relative (latex-live passes cMapUrl "/lib/pdfjs/cmaps/" to pdf.js).
// The page is file://, so those URLs arrive as file:///lib/...; redirect them to
// dist/lib. This holds the default session's only onBeforeRequest listener
// (Electron keeps one per session). Requests made by workers bypass webRequest,
// which is why loadPdfJs also rewrites pdf.js's asset URLs.
export function handleSchemes() {
	const lib = path.join(__dirname, "lib");
	session.defaultSession.webRequest.onBeforeRequest({ urls: ["file:///lib/*"] }, (details, callback) => {
		const url = new URL(details.url);
		let target: string;
		try {
			target = path.join(lib, decodeURIComponent(url.pathname).slice("/lib/".length));
		} catch {
			// A malformed %-escape (from a note or a plugin) names no file; thrown
			// here it would stop the main process with an error dialog.
			return callback({ cancel: true });
		}
		if (!target.startsWith(lib + path.sep)) return callback({ cancel: true });
		callback({ redirectURL: pathToFileURL(target).href + url.search });
	});
}
