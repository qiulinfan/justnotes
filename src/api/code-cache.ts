import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as vm from "node:vm";

// V8's compiled code for scripts the app evaluates (plugins, its own
// renderer.js), kept in the profile so a start does not compile them again:
// Chromium caches compiled code only for scripts it fetches over http(s). A
// file holds the code of one version of one script under one V8 version; V8
// itself rejects data that does not fit, and the script then compiles as
// without a cache.
export class CodeCache {
	constructor(readonly dir: string) {}

	#file(name: string, version: string) {
		const hash = createHash("sha1").update(process.versions.v8).update("\0").update(version).digest("hex").slice(0, 16);
		return nodePath.join(this.dir, `${encodeURIComponent(name)}-${hash}.bin`);
	}

	// Compiles `source` as a script in the page's global scope (what an
	// indirect eval does); `cached` tells whether stored code was used. run()
	// evaluates it; save() then stores its code, including the functions
	// compiled while it ran, unless stored code was used. Code is stored per
	// text, or per `version` when given (a stat, cheaper than hashing a big
	// bundle).
	async compile(name: string, source: string, filename: string, version = source) {
		const file = this.#file(name, version);
		let cachedData: Buffer | undefined;
		try {
			cachedData = await fs.promises.readFile(file);
		} catch {}
		const script = new vm.Script(source, { filename, cachedData });
		const used = !!cachedData && !script.cachedDataRejected;
		return {
			cached: used,
			run: () => script.runInThisContext(),
			save: async () => {
				if (used) return;
				await fs.promises.mkdir(this.dir, { recursive: true });
				// Older texts of the same plugin are dropped.
				const prefix = `${encodeURIComponent(name)}-`;
				for (const old of await fs.promises.readdir(this.dir)) {
					if (old.startsWith(prefix) && /^[0-9a-f]{16}\.bin$/.test(old.slice(prefix.length))) await fs.promises.rm(nodePath.join(this.dir, old), { force: true });
				}
				const tmp = `${file}.${process.pid}.tmp`;
				await fs.promises.writeFile(tmp, script.createCachedData());
				await fs.promises.rename(tmp, file);
			},
		};
	}
}
