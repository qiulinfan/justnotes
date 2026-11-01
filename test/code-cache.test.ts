import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodeCache } from "../src/api/code-cache";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function cache() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "justnotes-code-cache-"));
	dirs.push(dir);
	return new CodeCache(path.join(dir, "plugin-code-cache"));
}

const plugin = (body: string) => `(function anonymous(require, module, exports){${body}\n})\n//# sourceURL=plugin:p`;

test("a plugin's code runs as an eval would and is compiled from the stored code at the next start", async () => {
	const codeCache = cache();
	const source = plugin("module.exports = { answer: () => 42 }; globalThis.__codeCacheProbe = typeof require;");
	const first = await codeCache.compile("p", source, "plugin:p");
	expect(first.cached).toBe(false);
	const module = { exports: {} as any };
	first.run()(() => null, module, module.exports);
	expect(module.exports.answer()).toBe(42);
	expect((globalThis as any).__codeCacheProbe).toBe("function");
	await first.save();

	const second = await codeCache.compile("p", source, "plugin:p");
	expect(second.cached).toBe(true);
	const again = { exports: {} as any };
	second.run()(() => null, again, again.exports);
	expect(again.exports.answer()).toBe(42);
	delete (globalThis as any).__codeCacheProbe;
});

test("an updated plugin compiles afresh and replaces its old code; unreadable stored code is ignored", async () => {
	const codeCache = cache();
	const v1 = await codeCache.compile("p", plugin("module.exports = 1;"), "plugin:p");
	await v1.save();
	const v2 = await codeCache.compile("p", plugin("module.exports = 2;"), "plugin:p");
	expect(v2.cached).toBe(false);
	await v2.save();
	const other = await codeCache.compile("p-other", plugin("module.exports = 3;"), "plugin:p-other");
	await other.save();
	const files = fs.readdirSync(codeCache.dir).sort();
	expect(files.length).toBe(2);
	expect(files.filter((f) => f.startsWith("p-other-")).length).toBe(1);

	const v2file = files.find((f) => !f.startsWith("p-other-"))!;
	fs.writeFileSync(path.join(codeCache.dir, v2file), "not code");
	const broken = await codeCache.compile("p", plugin("module.exports = 2;"), "plugin:p");
	expect(broken.cached).toBe(false);
	const module = { exports: {} as any };
	broken.run()(() => null, module, module.exports);
	expect(module.exports).toBe(2);
});
