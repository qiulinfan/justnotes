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
