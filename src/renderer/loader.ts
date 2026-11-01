import * as fs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { CodeCache } from "../api/code-cache";

// Runs renderer.js with V8's code compiled at the last start (code-cache.ts):
// as a <script>, the 6 MB bundle would be compiled again on every start. It
// runs in the page's global scope, as a <script> would. Its code is stored 3 s
// after the layout is ready, so it holds what the start compiled, and stored
// again only when renderer.js (by size and mtime) or V8 changes.
async function load() {
	const url = new URL("renderer.js", document.baseURI).href;
	const file = fileURLToPath(url);
	const source = fs.readFileSync(file, "utf8");
	const { size, mtimeMs } = fs.statSync(file);
	const profile: string = (window as any).require("@electron/remote").app.getPath("userData");
	const cache = new CodeCache(nodePath.join(profile, "code-cache"));
	const compiled = await cache.compile("renderer", source, url, `${size}-${mtimeMs}`);
	compiled.run();
	if (!compiled.cached) {
		(window as any).app?.workspace.onLayoutReady(() =>
			setTimeout(() => compiled.save().catch((err) => console.warn("Could not cache the renderer's code", err)), 3000),
		);
	}
}

load().catch((err) => {
	// As an error in a <script> would: reported, and the page stays blank.
	setTimeout(() => {
		throw err;
	});
});
