import * as nodePath from "node:path";

// Ghostty's configuration, read (never written) to style the terminal like
// the user's own: `key = value` lines, `#` comments on their own lines,
// values optionally in double quotes. A key given again replaces its value,
// and an empty value puts it back to Ghostty's default; the repeatable keys
// (`palette`, `font-family`, `font-feature`) add to a list that an empty value
// clears. `config-file` loads another file after the one naming it is done
// (a relative path is relative to the naming file), so its values win. Paths (`background-image`) are resolved
// against the file that sets them, with `~` for the home folder.
export interface GhosttyConfig {
	// The last value of every single-valued key that is set.
	values: Map<string, string>;
	palette: Map<number, string>;
	fontFamily: string[];
	fontFeature: string[];
	// Every file read, for watching.
	files: string[];
}

export type ReadFile = (path: string) => string | null;

const LISTS = new Set(["font-family", "font-feature"]);
const PATHS = new Set(["background-image"]);
// Keys Ghostty may repeat or that name other files; never kept as values.
const IGNORED = new Set(["keybind", "config-file"]);

// The files Ghostty itself loads, in its order (later ones win): the XDG
// location, then on macOS the application support folder; each as `config`
// and as `config.ghostty`.
export function ghosttyConfigFiles(home: string, env: Record<string, string | undefined>, platform: string) {
	const xdg = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : nodePath.join(home, ".config");
	const dirs = [nodePath.join(xdg, "ghostty")];
	if (platform === "darwin") dirs.push(nodePath.join(home, "Library", "Application Support", "com.mitchellh.ghostty"));
	return dirs.flatMap((dir) => [nodePath.join(dir, "config"), nodePath.join(dir, "config.ghostty")]);
}

export function emptyConfig(): GhosttyConfig {
	return { values: new Map(), palette: new Map(), fontFamily: [], fontFeature: [], files: [] };
}

// Reads the given files in order (a missing one is skipped) into one config;
// null when none of them exists.
export function readGhosttyConfig(files: string[], read: ReadFile, home: string): GhosttyConfig | null {
	const config = emptyConfig();
	const seen = new Set<string>();
	let found = false;
	for (const file of files) {
		if (loadFile(config, file, read, home, seen)) found = true;
	}
	return found ? config : null;
}

function loadFile(config: GhosttyConfig, file: string, read: ReadFile, home: string, seen: Set<string>): boolean {
	if (seen.has(file)) return false;
	seen.add(file);
	const text = read(file);
	if (text === null) return false;
	config.files.push(file);
	const includes: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		const key = line.slice(0, eq).trim();
		const value = unquote(line.slice(eq + 1).trim());
		if (key === "config-file") {
			if (!value) continue;
			// Ghostty reports a missing file unless it is marked optional with `?`;
			// here a missing file is skipped either way.
			includes.push(resolvePath(value.replace(/^\?/, ""), nodePath.dirname(file), home));
		} else apply(config, key, value, nodePath.dirname(file), home);
	}
	for (const include of includes) loadFile(config, include, read, home, seen);
	return true;
}

function apply(config: GhosttyConfig, key: string, value: string, dir: string, home: string) {
	if (IGNORED.has(key)) return;
	if (key === "palette") {
		if (!value) return config.palette.clear();
		const m = /^(\d{1,3})\s*=\s*(.+)$/.exec(value);
		if (m && Number(m[1]) < 256) config.palette.set(Number(m[1]), m[2].trim());
		return;
	}
	if (LISTS.has(key)) {
		const list = key === "font-family" ? config.fontFamily : config.fontFeature;
		if (!value) list.length = 0;
		else list.push(...(key === "font-feature" ? value.split(",").map((f) => f.trim()).filter(Boolean) : [value]));
		return;
	}
	if (!value) config.values.delete(key);
	else config.values.set(key, PATHS.has(key) ? resolvePath(value, dir, home) : value);
}

function unquote(value: string) {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function resolvePath(value: string, dir: string, home: string) {
	if (value === "~" || value.startsWith("~/")) return nodePath.join(home, value.slice(1));
	return nodePath.resolve(dir, value);
}
