import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CliFlags } from "../api/plugin";
import { ask, cliAddress, completionCacheFile, defaultProfile, privateDir } from "./protocol";
import { BUILTINS, flagsOf, type PluginCommand } from "./spec";
import { pickVault, readKnownVaults } from "./vaults";

// Shell completion: `justnotes __complete <word ...> <current word>` prints
// the candidates for the current word, one `word<TAB>description` per line;
// the scripts `justnotes completion zsh|fish|bash` prints call it on every
// completion. Built-ins come from the command table. Plugin commands come
// from the running app, which reports what the vault's window registered
// (a `complete` request, which runs nothing and opens no window), else from
// the cache the app writes whenever plugins register or drop handlers.
// Nothing here starts the app or runs a command.

export interface Candidate {
	word: string;
	description: string;
}

// What the app answers a `complete` request with: the vault the words name
// and its window's plugin commands, or null when no window shows it.
export interface CompletionAnswer {
	vault: string | null;
	commands: PluginCommand[] | null;
}

// How long completion waits for the running app.
const APP_WAIT = 150;
// file= walks the vault for note names, up to this many entries.
const WALK_LIMIT = 20_000;
const NOTE_LIMIT = 500;

const GLOBAL: Candidate[] = [
	{ word: "--profile", description: "Profile folder of the instance" },
	{ word: "--offline", description: "Read the vault folder, never the app" },
	{ word: "--copy", description: "Also copy the output" },
	{ word: "--json", description: "Print the result as JSON" },
];
const VAULT: Candidate = { word: "vault=", description: "Vault name or path" };
const COPY: Candidate = { word: "--copy", description: "Also copy the output" };
const SHELLS = ["zsh", "fish", "bash"];

// An enumerated parameter's choices: `tsv|csv|json`.
export function choices(value: string | undefined) {
	return value && /^[A-Za-z]+(\|[A-Za-z]+)+$/.test(value) ? value.split("|") : null;
}

// A command's flags as words: key= for a parameter, the bare word for a
// switch, key=value for each choice of an enumerated parameter.
function flagWords(flags: CliFlags | null): Candidate[] {
	return Object.entries(flags ?? {}).flatMap(([key, flag]) => {
		const values = choices(flag.value);
		if (values) return values.map((v) => ({ word: `${key}=${v}`, description: flag.description }));
		return [{ word: flag.value ? `${key}=` : key, description: flag.description }];
	});
}

// The cache's commands as far as they are well formed: anything else in the
// file (another version's, a broken write) is left out, never trusted.
export function pluginCommandList(value: unknown): PluginCommand[] {
	if (!Array.isArray(value)) return [];
	const text = (v: unknown) => (typeof v === "string" ? v : "");
	return value.flatMap((item) => {
		if (!item || typeof item !== "object" || typeof item.name !== "string" || !/^\S+$/.test(item.name)) return [];
		const flags: CliFlags = {};
		if (item.flags && typeof item.flags === "object") {
			for (const [key, flag] of Object.entries(item.flags as Record<string, unknown>)) {
				if (!/^\S+$/.test(key) || !flag || typeof flag !== "object") continue;
				const { value: placeholder, description, required } = flag as Record<string, unknown>;
				flags[key] = { description: text(description), ...(typeof placeholder === "string" && { value: placeholder }), ...(required === true && { required }) };
			}
		}
		return [{ name: item.name, description: text(item.description), pluginId: text(item.pluginId), flags }];
	});
}

export function readCompletionCache(profile: string): Record<string, PluginCommand[]> {
	try {
		const cache = JSON.parse(fs.readFileSync(completionCacheFile(profile), "utf8"));
		if (!cache || typeof cache !== "object" || Array.isArray(cache)) return {};
		return Object.fromEntries(Object.entries(cache).map(([vault, commands]) => [vault, pluginCommandList(commands)]));
	} catch {
		return {};
	}
}

// Records a vault's plugin commands in the profile's cache (the app, when
// its window reports a change). Private like the socket: the folder 0700,
// the file 0600, replaced in one rename.
export function writeCompletionCache(profile: string, vault: string, commands: unknown) {
	const file = completionCacheFile(profile);
	privateDir(path.dirname(file));
	const cache = { ...readCompletionCache(profile), [vault]: pluginCommandList(commands) };
	const temp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
	fs.renameSync(temp, file);
}

function expandHome(dir: string) {
	return dir === "~" || dir.startsWith("~/") ? path.join(os.homedir(), dir.slice(1)) : dir;
}

interface Line {
	profile: string;
	offline: boolean;
	// The leading vault=, if given.
	lead: string[];
	command: string | undefined;
	// The command's words before the current one.
	rest: string[];
}

// The command line before the current word, read as justnotes.ts reads it.
function readLine(before: string[], cwd: string): Line {
	let profile = defaultProfile();
	let offline = false;
	let i = 0;
	for (; i < before.length; i++) {
		const word = before[i];
		if (word === "--profile") profile = before[++i] ?? profile;
		else if (word.startsWith("--profile=")) profile = word.slice("--profile=".length);
		else if (word === "--offline") offline = true;
		else if (word !== "--copy" && word !== "--json") break;
	}
	const lead = before[i]?.startsWith("vault=") ? [before[i++]] : [];
	return { profile: path.resolve(cwd, expandHome(profile)), offline, lead, command: before[i], rest: before.slice(i + 1) };
}

// The vault the line names and its plugin commands: the running app's
// answer, else the cache for the vault picked here (vault= or the working
// folder). --offline never asks the app.
async function plugins(line: Line, cwd: string): Promise<CompletionAnswer> {
	let vault: string | null = null;
	if (!line.offline) {
		// A long socket path changes into the socket's folder (enterSocketDir).
		const here = process.cwd();
		try {
			const response = await ask(cliAddress(line.profile), { argv: line.lead, cwd, complete: true }, APP_WAIT);
			const answer = JSON.parse(response.stdout) as CompletionAnswer;
			if (typeof answer.vault === "string") vault = answer.vault;
			if (vault && Array.isArray(answer.commands)) return { vault, commands: pluginCommandList(answer.commands) };
		} catch {
			// No app, a slow one, or a line it cannot place: the cache answers.
		} finally {
			process.chdir(here);
		}
	}
	if (!vault) {
		const picked = pickVault(line.lead, cwd, [], readKnownVaults(line.profile), null);
		if ("error" in picked) return { vault: null, commands: null };
		vault = picked.vault;
	}
	return { vault, commands: readCompletionCache(line.profile)[vault] ?? null };
}

function commandWords(commands: PluginCommand[] | null): Candidate[] {
	const builtins = [...BUILTINS.values()].map((spec) => ({ word: spec.name, description: spec.description }));
	const own = (commands ?? []).filter((c) => !BUILTINS.has(c.name)).map((c) => ({ word: c.name, description: `${c.description} (${c.pluginId})` }));
	return [...builtins, ...own];
}

// vault= with each known vault's folder name, or its path where two share one.
function vaultWords(profile: string): Candidate[] {
	const known = readKnownVaults(profile);
	const counts = new Map<string, number>();
	for (const vault of known) counts.set(path.basename(vault), (counts.get(path.basename(vault)) ?? 0) + 1);
	return known.map((vault) => ({ word: `vault=${counts.get(path.basename(vault))! > 1 ? vault : path.basename(vault)}`, description: vault }));
}

const hidden = (name: string) => name.startsWith(".");

// path= completes one folder level at a time, as a shell completes paths.
function pathWords(vault: string, prefix: string, value: string): Candidate[] {
	const dir = value.includes("/") ? value.slice(0, value.lastIndexOf("/") + 1) : "";
	if (dir.split("/").some((part) => part === ".." || part === ".")) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(vault, dir), { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => !hidden(entry.name) && (entry.isDirectory() || entry.isFile()))
		.map((entry) => (entry.isDirectory() ? { word: `${prefix}${dir}${entry.name}/`, description: "folder" } : { word: `${prefix}${dir}${entry.name}`, description: "" }))
		.sort((a, b) => a.word.localeCompare(b.word));
}

// file= takes a name as a wikilink does: a note's name without .md, any
// other file's with its extension. Names starting with what was typed, in
// any case, from a walk bounded for large vaults.
function fileWords(vault: string, prefix: string, value: string): Candidate[] {
	const typed = value.toLowerCase();
	const found = new Map<string, string>();
	const queue = [""];
	let walked = 0;
	while (queue.length && walked < WALK_LIMIT && found.size < NOTE_LIMIT) {
		const dir = queue.shift()!;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(vault, dir), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			walked++;
			if (hidden(entry.name)) continue;
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) queue.push(rel);
			else if (entry.isFile()) {
				const name = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : entry.name;
				if (name.toLowerCase().startsWith(typed) && !found.has(name)) found.set(name, rel);
			}
		}
	}
	return [...found].sort(([a], [b]) => a.localeCompare(b)).map(([name, rel]) => ({ word: `${prefix}${name}`, description: rel }));
}

// The candidates for the last word, given the words before it.
export async function completeWords(words: string[], cwd: string): Promise<Candidate[]> {
	const current = words.length ? words[words.length - 1] : "";
	const before = words.slice(0, -1);
	// The shell completes --profile's folder itself.
	if (before[before.length - 1] === "--profile") return [];
	const line = readLine(before, cwd);
	const { command, rest } = line;

	if (command === undefined) {
		if (!line.lead.length && current.startsWith("vault=")) return vaultWords(line.profile);
		const { commands } = await plugins(line, cwd);
		return [...(line.lead.length ? [] : [...GLOBAL, VAULT]), ...commandWords(commands)];
	}
	if (command === "help" || command === "--help" || command === "-h") return rest.length ? [] : commandWords((await plugins(line, cwd)).commands);
	if (command === "completion") return rest.length ? [] : SHELLS.map((shell) => ({ word: shell, description: `${shell} script` }));

	const spec = BUILTINS.get(command);
	let answer: CompletionAnswer | null = null;
	const answered = async () => (answer ??= await plugins(line, cwd));
	const flags = spec ? flagsOf(spec) : ((await answered()).commands?.find((c) => c.name === command)?.flags ?? null);

	const eq = current.indexOf("=");
	if (eq > 0) {
		const prefix = current.slice(0, eq + 1);
		const key = prefix.slice(prefix.startsWith("--") ? 2 : 0, -1);
		const values = choices(flags?.[key]?.value);
		if (values) return values.map((v) => ({ word: `${prefix}${v}`, description: flags![key].description }));
		if (key !== "file" && key !== "path") return [];
		const { vault } = await answered();
		if (!vault) return [];
		return key === "path" ? pathWords(vault, prefix, current.slice(eq + 1)) : fileWords(vault, prefix, current.slice(eq + 1));
	}
	// Flags already on the line are not offered again.
	const given = new Set(rest.map((word) => word.replace(/^--/, "").split("=")[0]));
	return [...flagWords(flags).filter((c) => !given.has(c.word.split("=")[0])), ...(given.has("copy") ? [] : [COPY])];
}

// The lines `justnotes __complete` prints. Tabs and newlines inside a
// description would break them.
export function candidateLines(candidates: Candidate[]) {
	return candidates.map((c) => (c.description ? `${c.word}\t${c.description.replace(/\s+/g, " ")}` : c.word)).join("\n");
}
