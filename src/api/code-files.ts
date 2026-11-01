import * as fs from "node:fs/promises";

// Source and data files justnotes opens in its code view (src/renderer/
// code-view.ts) when no view is registered for them, so they can be read and
// lightly edited without leaving the vault: by extension, or by name for
// files that have none.
const CODE_EXTENSIONS = new Set([
	// data and config
	"json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties", "xml", "plist", "csv", "tsv", "lock",
	// web
	"js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "css", "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro",
	// systems and general purpose
	"c", "h", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino", "rs", "go", "java", "kt", "kts", "scala", "swift", "m", "mm", "cs", "fs", "zig", "nim", "d", "dart",
	"py", "pyi", "rb", "php", "pl", "lua", "r", "jl", "ex", "exs", "erl", "hrl", "clj", "cljs", "hs", "ml", "mli", "elm", "lisp", "el", "scm", "rkt",
	// shells, build and queries
	"sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "cmake", "mk", "gradle", "sql", "graphql", "gql", "proto", "dockerfile",
	// text-like
	"diff", "patch", "log", "bib", "sty", "cls", "rst", "adoc", "org",
]);

const CODE_FILE_NAMES = new Set(["makefile", "dockerfile", "gemfile", "rakefile", "procfile", "justfile", "license", "readme"]);

export function isCodeFile(file: { name: string; extension: string }) {
	return CODE_EXTENSIONS.has(file.extension.toLowerCase()) || (!file.extension && CODE_FILE_NAMES.has(file.name.toLowerCase()));
}

// Larger files of an unknown kind go to the system's default app.
const TEXT_SNIFF_LIMIT = 10 * 1024 * 1024;
const SNIFF_BYTES = 8192;

// Whether a file of an unknown kind (a plugin's own format, such as a JSON
// board, whose plugin is gone) is text the code view can show: no NUL byte
// and valid UTF-8 in its first 8 KB, a character cut at the end allowed.
export async function isTextFile(fullPath: string) {
	let handle: fs.FileHandle | undefined;
	try {
		handle = await fs.open(fullPath, "r");
		if ((await handle.stat()).size > TEXT_SNIFF_LIMIT) return false;
		const buffer = new Uint8Array(SNIFF_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
		const head = buffer.subarray(0, bytesRead);
		if (head.includes(0)) return false;
		new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
		return true;
	} catch {
		return false;
	} finally {
		await handle?.close();
	}
}
